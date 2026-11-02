// Admin backup helpers: constant-time token check, a consistent SQLite snapshot,
// and a tiny dependency-free .zip writer (deflate, no zip64; fine for archives < 4 GB).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const MIN_TOKEN_LENGTH = 32;

// True only when a backup token is configured and long enough to be safe.
function backupEnabled(expected) {
  return typeof expected === 'string' && expected.length >= MIN_TOKEN_LENGTH;
}

// Reads the token from "X-Backup-Token: <t>" or "Authorization: Bearer <t>". Never from the query string.
function tokenFromRequest(req) {
  const header = req.get('x-backup-token');
  if (header) return String(header).trim();
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : '';
}

// Constant-time compare (hash both sides first so lengths never leak through timing).
function tokenMatches(provided, expected) {
  if (!backupEnabled(expected) || typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

// entries: [{ name, data: Buffer, date? }] -> Buffer containing a valid .zip archive.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach((entry) => {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const { time, day } = dosDateTime(entry.date);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  });
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// Minimal reader used by tests and the restore helper: returns [{ name, data }].
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function listFiles(dir, base) {
  const root = base || dir;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) return listFiles(full, root);
    if (!ent.isFile() || ent.name === '.gitkeep') return [];
    return [path.relative(root, full)];
  });
}

// Consistent online snapshot via SQLite's backup API (safe while the app keeps writing).
// Login sessions are stripped from the copy so the archive never carries live session cookies.
async function snapshotDatabase(db, Database) {
  const tmp = path.join(os.tmpdir(), `dt1-backup-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  try {
    await db.backup(tmp);
    const copy = new Database(tmp);
    try {
      const hasSessions = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
      if (hasSessions) copy.exec('DELETE FROM sessions');
      copy.exec('VACUUM');
    } finally {
      copy.close();
    }
    return fs.readFileSync(tmp);
  } finally {
    ['', '-wal', '-shm', '-journal'].forEach((s) => { try { fs.unlinkSync(tmp + s); } catch (e) { /* gone */ } });
  }
}

async function buildBackupArchive({ db, Database, uploadDir, meta }) {
  const now = new Date();
  const dbBytes = await snapshotDatabase(db, Database);
  const uploads = listFiles(uploadDir);
  const entries = [{ name: 'dt1.db', data: dbBytes, date: now }];
  uploads.forEach((rel) => {
    const full = path.join(uploadDir, rel);
    const st = fs.statSync(full);
    entries.push({ name: `uploads/${rel}`, data: fs.readFileSync(full), date: st.mtime });
  });
  const manifest = {
    app: 'dt1-tms',
    created_at: now.toISOString(),
    database_bytes: dbBytes.length,
    upload_files: uploads.length,
    ...(meta || {})
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), date: now });
  return { buffer: buildZip(entries), manifest };
}

module.exports = {
  MIN_TOKEN_LENGTH,
  backupEnabled,
  tokenFromRequest,
  tokenMatches,
  crc32,
  buildZip,
  readZip,
  listFiles,
  snapshotDatabase,
  buildBackupArchive
};
