// Minimal, dependency-free PDF writer for DT1 settlement and invoice PDFs (item 5, 11/15/2026).
// US Letter pages, Helvetica / Helvetica-Bold (built-in PDF fonts, WinAnsi encoding), text and lines.
// Coordinates passed in are from the TOP-left corner, in points (72 per inch).
'use strict';

const zlib = require('zlib');

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
    this.pageImages = [];
    this.footer = o.footer || '';
    this.pageNumbers = o.pageNumbers !== false;
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.images = [];
    this.pages.push(this.ops);
    this.pageImages.push(this.images);
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

  line(x1, y1, x2, y2, width, gray) {
    const g = gray == null ? 0.6 : gray;
    this.ops.push(`${(width || 0.5).toFixed(2)} w ${Number(g).toFixed(2)} G ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S 0 G`);
    return this;
  }

  shade(x, y, w, h) {
    this.ops.push(`0.93 g ${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
    return this;
  }

  // Stroke (and optional fill) a rectangle. y is the top edge in this writer's coordinates.
  rect(x, y, w, h, opts) {
    const o = opts || {};
    const width = (o.width || 0.8).toFixed(2);
    const gray = o.gray == null ? 0 : o.gray;
    const fill = o.fill != null ? `${Number(o.fill).toFixed(2)} g ` : '';
    const stroke = o.stroke === false ? '' : `${gray} G ${width} w `;
    const op = (o.fill != null && o.stroke !== false) ? 'B' : (o.fill != null ? 'f' : 'S');
    this.ops.push(`${fill}${stroke}${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${op} 0 g 0 G`);
    return this;
  }

  // Place an image (JPEG or PNG buffer) with its top-left at (x, y), fitted into w x h
  // (letterboxed). Unknown or unreadable images return false and draw nothing.
  image(x, y, w, h, buffer, nameHint) {
    const parsed = parseRasterImage(buffer, nameHint);
    if (!parsed) return false;
    const scale = Math.min(w / parsed.width, h / parsed.height);
    const dw = parsed.width * scale;
    const dh = parsed.height * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    const id = this.images.length + 1;
    this.images.push({ id, parsed });
    // PDF image space is 1x1 at the origin; cm maps it into the page (y is bottom-left).
    this.ops.push(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${(PAGE_H - dy - dh).toFixed(2)} cm /Im${id} Do Q`);
    return true;
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
      if (this.pageNumbers || this.footer) {
        const label = this.pageNumbers
          ? `${this.footer ? this.footer + '  ·  ' : ''}Page ${index + 1} of ${total}`
          : String(this.footer || '');
        if (label) {
          const bytes = toWinAnsiBytes(label);
          const w = textWidth(label, 8, false);
          footerOps.push(`BT 0.4 g /F1 8 Tf ${((PAGE_W - w) / 2).toFixed(2)} ${(this.margin / 2).toFixed(2)} Td (${escapePdfString(bytes)}) Tj ET`);
        }
      }
      const content = Buffer.from(ops.concat(footerOps).join('\n'), 'latin1');
      const contentId = add(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`);
      const images = this.pageImages[index] || [];
      const imageIds = {};
      images.forEach((img) => {
        const body = img.parsed.stream;
        const extra = img.parsed.extraDict || '';
        imageIds[img.id] = add(`<< /Type /XObject /Subtype /Image /Width ${img.parsed.width} /Height ${img.parsed.height} /ColorSpace ${img.parsed.colorSpace} /BitsPerComponent ${img.parsed.bits} /Filter /${img.parsed.filter} ${extra}/Length ${body.length} >>\nstream\n${body.toString('latin1')}\nendstream`);
      });
      const xos = images.length
        ? ' /XObject << ' + images.map((img) => `/Im${img.id} ${imageIds[img.id]} 0 R`).join(' ') + ' >>'
        : '';
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xos} >> /Contents ${contentId} 0 R >>`));
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

function jpegInfo(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) { i += 1; continue; }
    const marker = data[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (data[i + 2] << 8) + data[i + 3];
    // SOF0 / SOF1 / SOF2 (and a few other SOF markers) carry the size.
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const bits = data[i + 4];
      const height = (data[i + 5] << 8) + data[i + 6];
      const width = (data[i + 7] << 8) + data[i + 8];
      const comps = data[i + 9];
      const colorSpace = comps === 1 ? '/DeviceGray' : (comps === 4 ? '/DeviceCMYK' : '/DeviceRGB');
      const extraDict = comps === 4 ? '/Decode [1 0 1 0 1 0 1 0] ' : '';
      return { width, height, bits: bits || 8, colorSpace, filter: 'DCTDecode', stream: data, extraDict };
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

function unfilterPng(width, height, channels, data) {
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  let dst = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = data[src];
    src += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[src + x];
      const left = x >= channels ? out[dst + x - channels] : 0;
      const up = y > 0 ? out[dst + x - stride] : 0;
      const upLeft = y > 0 && x >= channels ? out[dst + x - stride - channels] : 0;
      let val = raw;
      if (filter === 1) val = (raw + left) & 255;
      else if (filter === 2) val = (raw + up) & 255;
      else if (filter === 3) val = (raw + ((left + up) >> 1)) & 255;
      else if (filter === 4) val = (raw + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) return null;
      out[dst + x] = val;
    }
    src += stride;
    dst += stride;
  }
  return out;
}

function pngInfo(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(sig)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 2;
  let interlace = 0;
  const idats = [];
  let palette = null;
  let trans = null;
  while (offset + 12 <= data.length) {
    const len = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const start = offset + 8;
    if (start + len + 4 > data.length) break;
    const chunk = data.subarray(start, start + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') trans = chunk;
    else if (type === 'IDAT') idats.push(chunk);
    else if (type === 'IEND') break;
    offset = start + len + 4;
  }
  if (!width || !height || interlace || bitDepth !== 8 || !idats.length) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idats)); } catch (err) { return null; }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) return null;
  const pixels = unfilterPng(width, height, channels, raw);
  if (!pixels) return null;
  let rgb;
  let colorSpace = '/DeviceRGB';
  if (colorType === 2) {
    rgb = pixels;
  } else if (colorType === 0) {
    rgb = pixels;
    colorSpace = '/DeviceGray';
  } else if (colorType === 6 || colorType === 4) {
    const srcCh = colorType === 6 ? 4 : 2;
    const dstCh = colorType === 6 ? 3 : 1;
    rgb = Buffer.alloc(width * height * dstCh);
    for (let i = 0, j = 0; i < pixels.length; i += srcCh, j += dstCh) {
      const alpha = pixels[i + srcCh - 1] / 255;
      for (let c = 0; c < dstCh; c += 1) {
        rgb[j + c] = Math.round(pixels[i + c] * alpha + 255 * (1 - alpha));
      }
    }
    colorSpace = dstCh === 1 ? '/DeviceGray' : '/DeviceRGB';
  } else if (colorType === 3 && palette) {
    rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      const idx = pixels[i];
      const a = trans && idx < trans.length ? trans[idx] / 255 : 1;
      rgb[i * 3] = Math.round((palette[idx * 3] || 0) * a + 255 * (1 - a));
      rgb[i * 3 + 1] = Math.round((palette[idx * 3 + 1] || 0) * a + 255 * (1 - a));
      rgb[i * 3 + 2] = Math.round((palette[idx * 3 + 2] || 0) * a + 255 * (1 - a));
    }
  } else {
    return null;
  }
  return {
    width, height, bits: 8, colorSpace, filter: 'FlateDecode',
    stream: zlib.deflateSync(rgb), extraDict: ''
  };
}

function parseRasterImage(buffer, nameHint) {
  const hint = String(nameHint || '').toLowerCase();
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!data.length) return null;
  if (hint.endsWith('.png') || (data[0] === 0x89 && data[1] === 0x50)) return pngInfo(data);
  if (hint.endsWith('.jpg') || hint.endsWith('.jpeg') || (data[0] === 0xff && data[1] === 0xd8)) return jpegInfo(data);
  return pngInfo(data) || jpegInfo(data);
}

module.exports = { SimplePdf, textWidth, fitText, toWinAnsiBytes, PAGE_W, PAGE_H, parseRasterImage, jpegInfo, pngInfo };
