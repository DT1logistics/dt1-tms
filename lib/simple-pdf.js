// Minimal, dependency-free PDF writer for DT1 settlement and invoice PDFs (item 5, 11/15/2026).
// US Letter pages, Helvetica / Helvetica-Bold (built-in PDF fonts, WinAnsi encoding), text and lines.
// Coordinates passed in are from the TOP-left corner, in points (72 per inch).
'use strict';

const PAGE_W = 612;
const PAGE_H = 792;

// Helvetica glyph widths (1/1000 em) for ASCII 32..126, from the standard Adobe AFM.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const WIN_ANSI = {
  '\u2013': 0x96, '\u2014': 0x97, '\u00b7': 0xb7, '\u2019': 0x92, '\u2018': 0x91,
  '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2026': 0x85, '\u20ac': 0x80
};

function toWinAnsiBytes(text) {
  const out = [];
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '\u2192') { out.push(0x2d, 0x3e); continue; } // → as ->
    const code = ch.codePointAt(0);
    if (WIN_ANSI[ch] != null) out.push(WIN_ANSI[ch]);
    else if (code >= 32 && code < 127) out.push(code);
    else if (code >= 160 && code <= 255) out.push(code);
    else if (code === 9) out.push(32);
    else out.push(0x3f);
  }
  return out;
}

function escapePdfString(bytes) {
  let s = '';
  bytes.forEach((b) => {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  });
  return s;
}

function textWidth(text, size, bold) {
  let units = 0;
  toWinAnsiBytes(text).forEach((b) => {
    const w = b >= 32 && b <= 126 ? HELV[b - 32] : 556;
    units += bold && !(b >= 48 && b <= 57) ? w * 1.06 : w;
  });
  return (units / 1000) * size;
}

function fitText(text, maxWidth, size, bold) {
  const value = String(text == null ? '' : text);
  if (textWidth(value, size, bold) <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && textWidth(cut + '…', size, bold) > maxWidth) cut = cut.slice(0, -1);
  return cut + '…';
}

class SimplePdf {
  constructor(opts) {
    const o = opts || {};
    this.margin = o.margin || 40;
    this.pages = [];
    this.footer = o.footer || '';
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.margin;
    return this;
  }

  get bottom() { return PAGE_H - this.margin - 20; }

  ensure(height) {
    if (this.y + height > this.bottom) {
      this.addPage();
      return true;
    }
    return false;
  }

  text(x, y, value, opts) {
    const o = opts || {};
    const size = o.size || 10;
    const bold = !!o.bold;
    let str = String(value == null ? '' : value);
    if (o.maxWidth) str = fitText(str, o.maxWidth, size, bold);
    let left = x;
    if (o.align === 'right') left = x - textWidth(str, size, bold);
    else if (o.align === 'center') left = x - textWidth(str, size, bold) / 2;
    const color = o.gray ? '0.4 g ' : '0 g ';
    this.ops.push(`BT ${color}/${bold ? 'F2' : 'F1'} ${size} Tf ${left.toFixed(2)} ${(PAGE_H - y - size).toFixed(2)} Td (${escapePdfString(toWinAnsiBytes(str))}) Tj ET`);
    return this;
  }

  line(x1, y1, x2, y2, width) {
    this.ops.push(`${(width || 0.5).toFixed(2)} w 0.6 G ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S`);
    return this;
  }

  shade(x, y, w, h) {
    this.ops.push(`0.93 g ${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
    return this;
  }

  // Flowing helpers: write at the cursor and move it down.
  heading(value, size) {
    const s = size || 16;
    this.ensure(s + 6);
    this.text(this.margin, this.y, value, { size: s, bold: true });
    this.y += s + 6;
    return this;
  }

  para(value, opts) {
    const o = opts || {};
    const size = o.size || 10;
    this.ensure(size + 4);
    this.text(this.margin, this.y, value, Object.assign({ size, maxWidth: PAGE_W - this.margin * 2 }, o));
    this.y += size + 4;
    return this;
  }

  gap(points) { this.y += points; return this; }

  rule() {
    this.ensure(6);
    this.line(this.margin, this.y + 2, PAGE_W - this.margin, this.y + 2);
    this.y += 6;
    return this;
  }

  // columns: [{ label, width, align }]; rows: arrays of strings. Header repeats on new pages.
  table(columns, rows, opts) {
    const o = opts || {};
    const size = o.size || 8;
    const rowH = size + 5;
    const totalW = columns.reduce((sum, c) => sum + c.width, 0);
    const drawHeader = () => {
      this.shade(this.margin, this.y, totalW, rowH);
      let x = this.margin;
      columns.forEach((c) => {
        const tx = c.align === 'right' ? x + c.width - 3 : x + 3;
        this.text(tx, this.y + 2, c.label, { size, bold: true, align: c.align, maxWidth: c.width - 6 });
        x += c.width;
      });
      this.y += rowH;
    };
    this.ensure(rowH * 2);
    drawHeader();
    rows.forEach((row) => {
      if (this.ensure(rowH)) drawHeader();
      let x = this.margin;
      columns.forEach((c, i) => {
        const tx = c.align === 'right' ? x + c.width - 3 : x + 3;
        this.text(tx, this.y + 2, row[i], { size, align: c.align, maxWidth: c.width - 6 });
        x += c.width;
      });
      this.line(this.margin, this.y + rowH, this.margin + totalW, this.y + rowH, 0.25);
      this.y += rowH;
    });
    this.y += 4;
    return this;
  }

  // Label / amount pairs aligned to the right edge.
  totals(pairs, opts) {
    const o = opts || {};
    const right = PAGE_W - this.margin;
    pairs.forEach(([label, amount, strong]) => {
      this.ensure(15);
      this.text(right - 110, this.y, label, { size: 10, bold: !!strong, align: 'right' });
      this.text(right, this.y, amount, { size: 10, bold: !!strong, align: 'right' });
      this.y += 14;
    });
    if (o.after) this.y += o.after;
    return this;
  }

  toBuffer() {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    const catalogId = add(null);
    const pagesId = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageIds = [];
    const total = this.pages.length;
    this.pages.forEach((ops, index) => {
      const footerOps = [];
      const label = `${this.footer ? this.footer + '  ·  ' : ''}Page ${index + 1} of ${total}`;
      const bytes = toWinAnsiBytes(label);
      const w = textWidth(label, 8, false);
      footerOps.push(`BT 0.4 g /F1 8 Tf ${((PAGE_W - w) / 2).toFixed(2)} ${(this.margin / 2).toFixed(2)} Td (${escapePdfString(bytes)}) Tj ET`);
      const content = Buffer.from(ops.concat(footerOps).join('\n'), 'latin1');
      const contentId = add(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`));
    });
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((off) => { out += `${String(off).padStart(10, '0')} 00000 n \n`; });
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

module.exports = { SimplePdf, textWidth, fitText, toWinAnsiBytes, PAGE_W, PAGE_H };
