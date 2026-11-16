// Logan's customer invoice layout (item 12). Reference: DT1-4011 page 1.
// Page 1 is the invoice. Ticket images/PDFs, when requested, follow in line order.
// Driver names, driver pay, and load numbers are never drawn.
'use strict';

const { SimplePdf, textWidth, PAGE_W, PAGE_H, parseRasterImage } = require('./simple-pdf');
const invoiceLib = require('./customer-invoice');
const invoiceNumber = require('./invoice-number');

const MARGIN = 54;

function formatShortDate(value) {
  const text = String(value == null ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return text || '';
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

function formatInvoiceDate(value) {
  const text = String(value == null ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m) return text || '';
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function formatQty(line) {
  if (!line) return '';
  if (line.usesTotalLoadPay) {
    const qty = line.billed ? line.billed.actualQty : line.weight_quantity;
    if (qty == null || qty === '') return '';
  }
  const qty = line.billed ? line.billed.qty : line.weight_quantity;
  if (qty == null || qty === '') return '';
  const n = Number(qty);
  if (!Number.isFinite(n)) return String(qty);
  if (line.billed && line.billed.mode === 'flat_qty_1') return String(Math.round(n) === n ? n : n.toFixed(3));
  if (Math.abs(n - Math.round(n)) < 1e-9 && n <= 1) return String(Math.round(n));
  return n.toFixed(3);
}

function formatMoneyNumber(value) {
  const n = Number(value) || 0;
  const text = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 && text !== '0.00' ? '-' : '') + text;
}

function dollarCell(pdf, x, width, y, amount, opts) {
  const o = opts || {};
  const size = o.size || 8;
  const dash = o.dashWhenZero && !(Number(amount) > 0);
  const text = dash ? '-' : formatMoneyNumber(amount);
  pdf.text(x + 3, y, '$', { size, bold: !!o.bold });
  pdf.text(x + width - 3, y, text, { size, bold: !!o.bold, align: 'right', maxWidth: width - 14 });
}

function underlineField(pdf, xRight, y, label, value, size, withLine) {
  const s = size || 9;
  const text = `${label} ${value}`;
  pdf.text(xRight, y, text, { size: s, align: 'right' });
  if (withLine !== false) {
    const w = textWidth(text, s, false) + 2;
    pdf.line(xRight - w, y + s + 2, xRight, y + s + 2, 0.6, 0);
  }
}

function columns() {
  // Total width 504 on a 612-pt page with 54-pt margins.
  const cols = [
    { key: 'date', label: 'Date', width: 54, align: 'left' },
    { key: 'ticket', label: 'Ticket #', width: 58, align: 'left' },
    { key: 'desc', label: 'Description', width: 98, align: 'left' },
    { key: 'qty', label: 'Qty', width: 42, align: 'right' },
    { key: 'rate', label: 'Rate', width: 48, align: 'money' },
    { key: 'fuel', label: 'Fuel Charge', width: 58, align: 'money' },
    { key: 'self', label: 'Self Load', width: 50, align: 'money' },
    { key: 'travel', label: 'Travel Time', width: 52, align: 'money' },
    { key: 'price', label: 'Price', width: 54, align: 'money' }
  ];
  let x = MARGIN;
  cols.forEach((col) => { col.x = x; x += col.width; });
  cols.tableWidth = x - MARGIN;
  return cols;
}

function drawTableHeader(pdf, cols, y) {
  const rowH = 16;
  const top = y - 2;
  cols.forEach((col) => {
    const tx = col.align === 'right' || col.align === 'money' ? col.x + col.width - 3 : col.x + 2;
    const align = col.align === 'right' || col.align === 'money' ? 'right' : 'left';
    pdf.text(tx, y, col.label, { size: 8, bold: true, align, maxWidth: col.width - 4 });
  });
  pdf.line(MARGIN, y + rowH - 3, MARGIN + cols.tableWidth, y + rowH - 3, 0.9, 0);
  cols.headerTop = top;
  cols.headerBottom = y + rowH - 3;
  return y + rowH;
}

function drawTableGrid(pdf, cols, bottomY) {
  const top = cols.headerTop != null ? cols.headerTop : MARGIN;
  const right = MARGIN + cols.tableWidth;
  pdf.line(MARGIN, top, right, top, 0.8, 0);
  pdf.line(MARGIN, bottomY, right, bottomY, 0.8, 0);
  pdf.line(MARGIN, top, MARGIN, bottomY, 0.8, 0);
  let x = MARGIN;
  cols.forEach((col) => {
    x += col.width;
    pdf.line(x, top, x, bottomY, 0.5, 0);
  });
}

function drawLineRow(pdf, cols, y, line) {
  const rowH = 14;
  const size = 8;
  const qty = formatQty(line);
  const cells = {
    date: formatShortDate(line.load_date),
    ticket: line.ticket_number || '',
    desc: line.description || invoiceLib.haulDescription(line),
    qty
  };
  ['date', 'ticket', 'desc', 'qty'].forEach((key) => {
    const col = cols.find((c) => c.key === key);
    const tx = col.align === 'right' ? col.x + col.width - 3 : col.x + 2;
    pdf.text(tx, y, cells[key], { size, align: col.align === 'right' ? 'right' : 'left', maxWidth: col.width - 4 });
  });
  const rateCol = cols.find((c) => c.key === 'rate');
  const fuelCol = cols.find((c) => c.key === 'fuel');
  const selfCol = cols.find((c) => c.key === 'self');
  const travelCol = cols.find((c) => c.key === 'travel');
  const priceCol = cols.find((c) => c.key === 'price');
  if (line.usesTotalLoadPay) {
    dollarCell(pdf, rateCol.x, rateCol.width, y, 0, { size, dashWhenZero: true });
  } else {
    dollarCell(pdf, rateCol.x, rateCol.width, y, line.billed ? line.billed.rate : line.rate, { size });
  }
  if (line.fscApplies && !line.fscPending) {
    dollarCell(pdf, fuelCol.x, fuelCol.width, y, line.lineFsc, { size });
  } else {
    dollarCell(pdf, fuelCol.x, fuelCol.width, y, 0, { size, dashWhenZero: true });
  }
  dollarCell(pdf, selfCol.x, selfCol.width, y, line.selfLoad, { size, dashWhenZero: true });
  dollarCell(pdf, travelCol.x, travelCol.width, y, line.travelTime, { size, dashWhenZero: true });
  dollarCell(pdf, priceCol.x, priceCol.width, y, line.price, { size });
  pdf.line(MARGIN, y + rowH - 3, MARGIN + cols.tableWidth, y + rowH - 3, 0.25, 0.55);
  return y + rowH;
}

function wrapRemitLines(settings) {
  const intro = settings.remit_intro || invoiceLib.DEFAULT_SETTINGS.remit_intro;
  const name = settings.remit_name || invoiceLib.DEFAULT_SETTINGS.remit_name;
  const a1 = settings.remit_address1 || '';
  const a2 = settings.remit_address2 || '';
  // Split the long legal name the way Logan's template does (break before "dba").
  const nameLines = [];
  const dba = String(name).match(/^(.*?)\s+(dba\s+.*)$/i);
  if (dba) {
    nameLines.push(dba[1], dba[2]);
  } else {
    const words = String(name).split(/\s+/);
    let current = '';
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (textWidth(next, 7, false) > 190 && current) {
        nameLines.push(current);
        current = word;
      } else current = next;
    });
    if (current) nameLines.push(current);
  }
  return [intro, ...nameLines, a1, a2].filter((line) => String(line || '').trim() !== '');
}

function drawFooter(pdf, invoice, settings, cols, y) {
  const totals = invoice.totals || invoiceLib.emptyTotals();
  const priceCol = cols.find((c) => c.key === 'price');
  const qtyCol = cols.find((c) => c.key === 'qty');
  const labelX = cols.find((c) => c.key === 'self').x - 2;
  const rows = [
    ['Hauling', totals.hauling, false, false],
    ['Fuel Surcharge', totals.fuelSurcharge, false, false],
    ['Travel Time', totals.travelTime, false, true],
    ['Self Load', totals.selfLoad, false, true],
    ['TOTAL', totals.total, true, false]
  ];
  if (Number(totals.shipperDetention) > 0) {
    rows.splice(4, 0, ['Detention', totals.shipperDetention, false, false]);
  }
  const rowH = 14;
  const boxTop = y;
  const boxHeight = rowH * rows.length + 6;
  const boxWidth = (qtyCol.x + qtyCol.width) - MARGIN;
  pdf.rect(MARGIN, boxTop, boxWidth, boxHeight, { width: 1.1, gray: 0 });
  const remit = wrapRemitLines(settings);
  let ry = boxTop + 4;
  remit.forEach((line, i) => {
    pdf.text(MARGIN + 5, ry, line, { size: 7, bold: i === 0, maxWidth: Math.max(170, boxWidth) - 10 });
    ry += 10;
  });
  let ty = boxTop + 2;
  rows.forEach((row) => {
    pdf.text(labelX, ty, row[0], { size: 8, bold: row[2], align: 'right' });
    dollarCell(pdf, priceCol.x, priceCol.width, ty, row[1], { size: 8, bold: row[2], dashWhenZero: row[3] });
    ty += rowH;
  });
  return boxTop + boxHeight;
}

function drawHeader(pdf, invoice, settings, cols) {
  let y = 48;
  pdf.text(MARGIN, y, settings.company_name || 'DT1 Logistics, LLC', { size: 12, bold: true });
  y += 16;
  pdf.text(MARGIN, y, settings.company_address1 || '', { size: 9, bold: true });
  pdf.text(200, y, `Phone Number: ${settings.company_phone || ''}`, { size: 9 });
  pdf.text(400, y, `Email: ${settings.company_email || ''}`, { size: 9 });
  y += 12;
  pdf.text(MARGIN, y, settings.company_address2 || '', { size: 9, bold: true });
  y += 22;

  const right = PAGE_W - MARGIN;
  pdf.text(MARGIN, y, `Bill To: ${invoice.customer_name || ''}`, { size: 9, bold: true, maxWidth: 220 });
  if (invoice.poc_phone) pdf.text(200, y, `Phone: ${invoice.poc_phone}`, { size: 9 });
  underlineField(pdf, right, y, 'Invoice #:', invoice.number || '', 9, false);
  y += 14;
  const addr1 = invoice.address_line1 || '';
  pdf.text(MARGIN, y, addr1 ? `Address: ${addr1}` : 'Address:', { size: 9, maxWidth: 240 });
  if (invoice.poc_email) pdf.text(300, y, `Email: ${invoice.poc_email}`, { size: 9, maxWidth: 160 });
  underlineField(pdf, right, y, 'Invoice Date:', formatInvoiceDate(invoice.invoiceDate || invoice.invoice_date), 9, false);
  y += 14;
  if (invoice.address_line2) pdf.text(MARGIN, y, invoice.address_line2, { size: 9, maxWidth: 280 });
  underlineField(pdf, right, y, 'Terms:', invoice.terms || 'Net 30', 9);
  y += 24;

  const projectName = invoice.project_name || invoice.projectName || '';
  pdf.text(MARGIN, y, `Project: ${projectName}`, { size: 11, bold: true });
  y += 16;
  return drawTableHeader(pdf, cols, y);
}

function addTicketPages(pdf, tickets) {
  (tickets || []).forEach((ticket) => {
    pdf.addPage();
    const label = `Ticket #: ${ticket.ticket_number || ''}`.trim();
    pdf.text(MARGIN, 28, label, { size: 9, bold: true });
    const boxX = 36;
    const boxY = 44;
    const boxW = PAGE_W - 72;
    const boxH = PAGE_H - 80;
    const name = ticket.original_name || ticket.filename || '';
    const buf = ticket.buffer || ticket.file_blob;
    if (buf && parseRasterImage(buf, name)) {
      pdf.image(boxX, boxY, boxW, boxH, buf, name);
    } else if (buf && Buffer.isBuffer(buf) && buf.slice(0, 5).toString() === '%PDF-') {
      pdf.text(MARGIN, 80, 'This weigh ticket is a PDF file and is listed here in line order:', { size: 10 });
      pdf.text(MARGIN, 96, name || 'ticket.pdf', { size: 10 });
      pdf.text(MARGIN, 112, 'Open the ticket from the load record if you need the original file.', { size: 9, gray: true });
    } else {
      pdf.text(MARGIN, 80, `Ticket image could not be attached${name ? ': ' + name : '.'}`, { size: 10 });
    }
  });
}

function buildCustomerInvoicePdf(invoice, opts) {
  const o = opts || {};
  const settings = o.settings || invoiceLib.readSettings(o.db) || invoiceLib.defaultSettings();
  const cols = columns();
  const pdf = new SimplePdf({ margin: MARGIN, pageNumbers: false, footer: '' });
  // First page was created by the constructor; we draw on it directly.
  const lines = invoice.loads || [];
  const footerHeight = 20 + 14 * (5 + (invoice.totals && Number(invoice.totals.shipperDetention) > 0 ? 1 : 0));
  let y = drawHeader(pdf, invoice, settings, cols);
  lines.forEach((line, i) => {
    const need = 14 + (i === lines.length - 1 ? footerHeight : 0);
    if (y + need > PAGE_H - 40) {
      pdf.addPage();
      y = drawHeader(pdf, invoice, settings, cols);
    }
    y = drawLineRow(pdf, cols, y, line);
  });
  const tableBottom = lines.length ? y - 3 : y;
  drawTableGrid(pdf, cols, tableBottom);
  if (y + footerHeight > PAGE_H - 36) {
    pdf.addPage();
    y = drawHeader(pdf, invoice, settings, cols);
  }
  drawFooter(pdf, invoice, settings, cols, y + 8);
  if (o.includeTickets !== false) addTicketPages(pdf, o.tickets || []);
  return pdf.toBuffer();
}

function invoiceFileName(invoice) {
  return invoiceNumber.invoiceFileName(invoice.number, invoice.project_name || invoice.projectName || 'Invoice');
}

module.exports = {
  buildCustomerInvoicePdf,
  invoiceFileName,
  formatShortDate,
  formatInvoiceDate,
  formatQty,
  columns
};
