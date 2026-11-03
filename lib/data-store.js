// Where the TMS keeps its SQLite file and uploads. DATA_DIR points at a Render persistent
// disk (e.g. /var/data); without it the app keeps using the repo folder like before.
const fs = require('fs');
const path = require('path');

function resolveDataDir(env, legacyDir) {
  const raw = env && env.DATA_DIR ? String(env.DATA_DIR).trim() : '';
  return path.resolve(raw || legacyDir);
}

function copyMissingFiles(fromDir, toDir) {
  if (!fs.existsSync(fromDir)) return 0;
  let copied = 0;
  fs.mkdirSync(toDir, { recursive: true });
  fs.readdirSync(fromDir, { withFileTypes: true }).forEach((ent) => {
    if (ent.name === '.gitkeep') return;
    const src = path.join(fromDir, ent.name);
    const dest = path.join(toDir, ent.name);
    if (ent.isDirectory()) copied += copyMissingFiles(src, dest);
    else if (ent.isFile() && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      copied += 1;
    }
  });
  return copied;
}

// One-time move from the old location into DATA_DIR. Never overwrites anything already there.
// Returns { database: bool, uploads: n } describing what was copied.
function migrateLegacyData({ dataDir, legacyDir, dbName, uploadsName }) {
  const result = { database: false, uploads: 0 };
  if (path.resolve(dataDir) === path.resolve(legacyDir)) return result;
  fs.mkdirSync(dataDir, { recursive: true });
  const newDb = path.join(dataDir, dbName);
  const oldDb = path.join(legacyDir, dbName);
  if (!fs.existsSync(newDb) && fs.existsSync(oldDb)) {
    fs.copyFileSync(oldDb, newDb);
    ['-wal', '-shm'].forEach((suffix) => {
      if (fs.existsSync(oldDb + suffix)) fs.copyFileSync(oldDb + suffix, newDb + suffix);
    });
    result.database = true;
  }
  result.uploads = copyMissingFiles(path.join(legacyDir, uploadsName), path.join(dataDir, uploadsName));
  return result;
}

module.exports = { resolveDataDir, migrateLegacyData, copyMissingFiles };
