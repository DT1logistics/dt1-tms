// express-session store backed by the app's SQLite file, so restarts and deploys
// don't sign everyone out. getDb() is called lazily because the DB opens in boot().
const session = require('express-session');

class SqliteSessionStore extends session.Store {
  constructor(getDb, opts) {
    super();
    this.getDb = getDb;
    this.defaultTtlMs = (opts && opts.ttlMs) || 24 * 60 * 60 * 1000;
    this.ready = false;
  }

  db() {
    const db = this.getDb();
    if (!db) throw new Error('Database is not open yet');
    if (!this.ready) {
      db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires)');
      this.ready = true;
    }
    return db;
  }

  expiry(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(exp) ? exp : Date.now() + this.defaultTtlMs;
  }

  get(sid, cb) {
    try {
      const row = this.db().prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.db().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.sess));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.db().prepare(`
        INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sess), this.expiry(sess));
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.db().prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this.expiry(sess), sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.db().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  prune() {
    try {
      return this.db().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()).changes;
    } catch (err) {
      return 0;
    }
  }
}

module.exports = SqliteSessionStore;
