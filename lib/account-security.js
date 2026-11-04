const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const RESET_TTL_MS = 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_EMAIL = 5;
const MAX_ATTEMPTS_PER_IP = 20;
const GENERIC_MESSAGE = 'If an account exists for that email, we sent a link to choose a new password. The link expires in one hour and works only once.';
const RATE_LIMIT_MESSAGE = 'Too many reset attempts. Please wait and try again.';
const INVALID_RESET_MESSAGE = 'This reset link is invalid or has expired.';
const BOOTSTRAP_META_KEY = 'bootstrap_password_reset';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function newResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function sealFromHash(passwordHash) {
  return `h1:${passwordHash}`;
}

function tempPasswordIsSealed(value) {
  return String(value || '').startsWith('h1:');
}

function revealableTempPassword(value) {
  const text = String(value || '').trim();
  if (!text || tempPasswordIsSealed(text)) return '';
  return text;
}

function initialPassword(envValue) {
  const fromEnv = String(envValue == null ? '' : envValue).trim();
  if (fromEnv) return { password: fromEnv, mustChange: false, source: 'env' };
  return { password: generatePassword(), mustChange: true, source: 'random' };
}

function ensureAuthTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_attempts_scope
      ON password_reset_attempts(scope, created_at);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function invalidateResetTokens(db, userId, now) {
  db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, userId);
}

function setUserPassword(db, userId, password, mustChange, now) {
  const hash = bcrypt.hashSync(String(password), 10);
  const temp = mustChange ? sealFromHash(hash) : null;
  db.prepare('UPDATE users SET password = ?, must_change_password = ?, temp_password = ? WHERE id = ?')
    .run(hash, mustChange ? 1 : 0, temp, userId);
  invalidateResetTokens(db, userId, now || Date.now());
  return hash;
}

function recentAttempts(db, scope, now) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM password_reset_attempts WHERE scope = ? AND created_at >= ?'
  ).get(scope, now - ATTEMPT_WINDOW_MS).n;
}

function noteAttempt(db, scope, now) {
  db.prepare('INSERT INTO password_reset_attempts (scope, created_at) VALUES (?, ?)').run(scope, now);
}

function findActiveToken(db, token, now) {
  const row = db.prepare(`
    SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email
    FROM password_reset_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(hashToken(token));
  if (!row || row.used_at || Number(row.expires_at) <= Number(now)) return null;
  return row;
}

async function requestPasswordReset({ db, email, ip, now, sendLink }) {
  const normalized = String(email || '').trim().toLowerCase();
  const stamp = Number(now);
  db.prepare('DELETE FROM password_reset_attempts WHERE created_at < ?').run(stamp - ATTEMPT_WINDOW_MS);
  const emailScope = `email:${normalized}`;
  const ipScope = `ip:${String(ip || 'unknown')}`;
  const limited = (normalized && recentAttempts(db, emailScope, stamp) >= MAX_ATTEMPTS_PER_EMAIL)
    || recentAttempts(db, ipScope, stamp) >= MAX_ATTEMPTS_PER_IP;
  if (limited) {
    return { limited: true, message: RATE_LIMIT_MESSAGE, emailFailed: false };
  }
  if (normalized) noteAttempt(db, emailScope, stamp);
  noteAttempt(db, ipScope, stamp);
  if (!normalized) {
    return { limited: false, message: GENERIC_MESSAGE, emailFailed: false };
  }

  const user = db.prepare(
    'SELECT id, email, name, password, must_change_password, temp_password FROM users WHERE LOWER(TRIM(email)) = ?'
  ).get(normalized);
  if (!user) {
    return { limited: false, message: GENERIC_MESSAGE, emailFailed: false };
  }

  const token = newResetToken();
  const inserted = db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(user.id, hashToken(token), stamp + RESET_TTL_MS, stamp);

  let sent = false;
  let error = null;
  try {
    const result = await sendLink({ to: user.email, name: user.name || '', token });
    sent = !!(result && result.sent);
  } catch (err) {
    error = err;
    sent = false;
  }
  if (!sent) {
    db.prepare('DELETE FROM password_reset_tokens WHERE id = ?').run(inserted.lastInsertRowid);
    return { limited: false, message: GENERIC_MESSAGE, emailFailed: true, error };
  }
  db.prepare(`
    UPDATE password_reset_tokens
    SET used_at = ?
    WHERE user_id = ? AND id != ? AND used_at IS NULL
  `).run(stamp, user.id, inserted.lastInsertRowid);
  return { limited: false, message: GENERIC_MESSAGE, emailFailed: false };
}

function peekResetToken(db, token, now) {
  const row = findActiveToken(db, token, now);
  if (!row) return { ok: false, error: INVALID_RESET_MESSAGE };
  return { ok: true, email: row.email, userId: row.user_id };
}

function consumePasswordReset({ db, token, password, now }) {
  const row = findActiveToken(db, token, now);
  if (!row) return { ok: false, error: INVALID_RESET_MESSAGE };
  if (typeof password !== 'string' || password.length < 6) {
    return { ok: false, error: 'Password must be at least 6 characters.', retry: true };
  }
  const stamp = Number(now);
  const hash = bcrypt.hashSync(password, 10);
  const changed = db.transaction(() => {
    const current = db.prepare('SELECT used_at, expires_at FROM password_reset_tokens WHERE id = ?').get(row.id);
    if (!current || current.used_at || Number(current.expires_at) <= stamp) return false;
    db.prepare('UPDATE users SET password = ?, must_change_password = 0, temp_password = NULL WHERE id = ?')
      .run(hash, row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .run(stamp, row.user_id);
    return true;
  })();
  if (!changed) return { ok: false, error: INVALID_RESET_MESSAGE };
  return { ok: true, userId: row.user_id };
}

function bootstrapMaterial(email, tempPassword) {
  return `${String(email || '').trim().toLowerCase()}\0${String(tempPassword || '')}`;
}

function applyBootstrapReset({ db, email, lookupEmail, tempPassword, now }) {
  const rawEmail = String(email || '').trim();
  const password = String(tempPassword || '').trim();
  const findEmail = String(lookupEmail || rawEmail).trim().toLowerCase();
  if (!rawEmail || !password) return { applied: false, reason: 'unset' };

  const existing = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(BOOTSTRAP_META_KEY);
  if (existing && bcrypt.compareSync(bootstrapMaterial(rawEmail, password), existing.value)) {
    return { applied: false, reason: 'already' };
  }

  const user = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = ?').get(findEmail);
  if (!user) return { applied: false, reason: 'missing' };

  const stamp = Number(now) || Date.now();
  const marker = bcrypt.hashSync(bootstrapMaterial(rawEmail, password), 10);
  db.transaction(() => {
    setUserPassword(db, user.id, password, true, stamp);
    db.prepare(`
      INSERT INTO app_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(BOOTSTRAP_META_KEY, marker);
  })();
  return { applied: true };
}

module.exports = {
  RESET_TTL_MS,
  ATTEMPT_WINDOW_MS,
  MAX_ATTEMPTS_PER_EMAIL,
  MAX_ATTEMPTS_PER_IP,
  GENERIC_MESSAGE,
  RATE_LIMIT_MESSAGE,
  INVALID_RESET_MESSAGE,
  hashToken,
  newResetToken,
  generatePassword,
  sealFromHash,
  tempPasswordIsSealed,
  revealableTempPassword,
  initialPassword,
  ensureAuthTables,
  setUserPassword,
  requestPasswordReset,
  peekResetToken,
  consumePasswordReset,
  applyBootstrapReset
};
