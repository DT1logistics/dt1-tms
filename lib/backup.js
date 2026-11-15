// Admin backup helpers: constant-time token check, a consistent SQLite snapshot,
// and a tiny dependency-free .zip writer (deflate, no zip64; fine for archives < 4 GB).
// The /admin/backup route uses streamBackupArchive(): the snapshot is written to a temp file
// on disk and every entry is streamed through deflate straight to the response, so memory use
// stays flat no matter how big dt1.db or the uploads folder get.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable, Transform, pipeline } = require('stream');

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

// crc32(buf) for a whole buffer, or crc32(chunk, previous) to continue over a stream.
function crc32(buf, previous) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, previous === undefined ? 0 : previous) >>> 0; // Node >= 20.15
  let c = (previous === undefined ? 0 : previous) ^ 0xFFFFFFFF;
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

const SNAPSHOT_PREFIX = '.dt1-backup-snapshot-';

function removeDbFile(file) {
  ['', '-wal', '-shm', '-journal'].forEach((s) => { try { fs.unlinkSync(file + s); } catch (e) { /* gone */ } });
}

// Removes snapshot temp files left behind by a crash mid-backup. Only call when no backup is running.
function cleanupStaleSnapshots(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let removed = 0;
  fs.readdirSync(dir).forEach((name) => {
    if (!name.startsWith(SNAPSHOT_PREFIX)) return;
    try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch (e) { /* gone */ }
  });
  return removed;
}

// Consistent online snapshot via SQLite's backup API (safe while the app keeps writing), written to
// a temp file in tmpDir (the persistent disk on Render, not memory). Login sessions are stripped from
// the copy so the archive never carries live session cookies. Returns the temp file path; the caller
// must delete it with removeDbFile().
async function snapshotDatabaseToFile(db, Database, tmpDir) {
  const dir = tmpDir || os.tmpdir();
  const tmp = path.join(dir, `${SNAPSHOT_PREFIX}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
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
    ['-wal', '-shm', '-journal'].forEach((s) => { try { fs.unlinkSync(tmp + s); } catch (e) { /* gone */ } });
    return tmp;
  } catch (err) {
    removeDbFile(tmp);
    throw err;
  }
}

// Kept for callers that want the snapshot bytes (small databases / tests).
async function snapshotDatabase(db, Database, tmpDir) {
  const tmp = await snapshotDatabaseToFile(db, Database, tmpDir);
  try {
    return fs.readFileSync(tmp);
  } finally {
    removeDbFile(tmp);
  }
}

// Waits until a writable stream can take more data; rejects if it closes or errors first.
function waitForDrain(out) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { out.off('drain', onDrain); out.off('close', onClose); out.off('error', onError); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Backup client disconnected')); };
    const onError = (err) => { cleanup(); reject(err); };
    out.on('drain', onDrain);
    out.on('close', onClose);
    out.on('error', onError);
  });
}

async function writeOut(out, chunk) {
  if (out.destroyed || out.writableEnded) throw new Error('Backup client disconnected');
  if (!out.write(chunk)) await waitForDrain(out);
}

// Streaming zip writer. entries: [{ name, file?: path, data?: Buffer|string, date? }].
// Each entry is deflated in chunks and written to `out` as it is produced (general-purpose flag bit 3:
// CRC and sizes follow the data in a data descriptor and are repeated in the central directory),
// so only one small chunk is ever held in memory. Does not end `out`. Resolves with { bytes }.
async function streamZip(entries, out) {
  const centrals = [];
  let offset = 0;
  const emit = async (buf) => { await writeOut(out, buf); offset += buf.length; };
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const { time, day } = dosDateTime(entry.date);
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // UTF-8 names + data descriptor
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    // CRC and sizes stay 0 here; they are in the data descriptor and central directory.
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await emit(local);
    await emit(name);

    let crc = 0;
    let size = 0;
    let csize = 0;
    const source = entry.file
      ? fs.createReadStream(entry.file, { highWaterMark: 64 * 1024 })
      : Readable.from([Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)]);
    const counter = new Transform({
      transform(chunk, enc, cb) { crc = crc32(chunk, crc); size += chunk.length; cb(null, chunk); }
    });
    const deflated = pipeline(source, counter, zlib.createDeflateRaw(), () => {});
    for await (const chunk of deflated) {
      csize += chunk.length;
      await emit(chunk);
    }
    if (size >= 0xFFFFFFFF || csize >= 0xFFFFFFFF || offset >= 0xFFFFFFFF) throw new Error('Backup entry too large for zip without zip64');

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(csize, 8);
    descriptor.writeUInt32LE(size, 12);
    await emit(descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(csize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
  }
  const centralStart = offset;
  for (const buf of centrals) await emit(buf);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  await emit(end);
  return { bytes: offset };
}

// Streams the full backup (dt1.db snapshot, uploads/..., manifest.json — same layout as before) to `out`.
// onReady(manifest) is called after the snapshot succeeds and before the first byte is written, so the
// route can still send an error status if the snapshot fails. The temp snapshot is always deleted.
async function streamBackupArchive({ db, Database, uploadDir, tmpDir, meta, out, onReady }) {
  const now = new Date();
  const dbFile = await snapshotDatabaseToFile(db, Database, tmpDir);
  try {
    const uploads = listFiles(uploadDir);
    const entries = [{ name: 'dt1.db', file: dbFile, date: now }];
    uploads.forEach((rel) => {
      const full = path.join(uploadDir, rel);
      entries.push({ name: `uploads/${rel}`, file: full, date: fs.statSync(full).mtime });
    });
    const manifest = {
      app: 'dt1-tms',
      created_at: now.toISOString(),
      database_bytes: fs.statSync(dbFile).size,
      upload_files: uploads.length,
      ...(meta || {})
    };
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), date: now });
    if (onReady) onReady(manifest);
    const { bytes } = await streamZip(entries, out);
    return { manifest, bytes };
  } finally {
    removeDbFile(dbFile);
  }
}

// Buffered variant (old behaviour), kept for small archives and tests. The route does NOT use it.
async function buildBackupArchive({ db, Database, uploadDir, tmpDir, meta }) {
  const now = new Date();
  const dbBytes = await snapshotDatabase(db, Database, tmpDir);
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
  snapshotDatabaseToFile,
  cleanupStaleSnapshots,
  removeDbFile,
  streamZip,
  streamBackupArchive,
  buildBackupArchive,
  SNAPSHOT_PREFIX
};
