const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

let db = null;

function toSqlValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function getDbPath() {
  const p = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'bot.sqlite3');
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function openDb() {
  if (db) return db;

  const filePath = getDbPath();
  ensureDirForFile(filePath);

  sqlite3.verbose();
  db = new sqlite3.Database(filePath);
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON;');
    db.run('PRAGMA journal_mode = WAL;');
  });

  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    openDb().run(sql, params.map(toSqlValue), function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    openDb().get(sql, params.map(toSqlValue), (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    openDb().all(sql, params.map(toSqlValue), (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function ensureColumn(table, column, typeSql) {
  const cols = await all(`PRAGMA table_info(${table});`);
  const has = cols.some((c) => c && c.name === column);
  if (has) return;
  await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql};`);
}

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS bot_users (
      user_id INTEGER PRIMARY KEY,
      lang TEXT,
      phone TEXT,
      contractor_profile_id TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      card_number TEXT NOT NULL,
      card_name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      FOREIGN KEY (user_id) REFERENCES bot_users(user_id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      phone TEXT,
      card_number TEXT NOT NULL,
      card_name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      receipt_file_id TEXT,
      approved_by INTEGER,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      FOREIGN KEY (user_id) REFERENCES bot_users(user_id) ON DELETE CASCADE
    );
  `);

  // Legacy schema upgrades (if DB file already exists)
  await ensureColumn('bot_users', 'contractor_profile_id', 'TEXT');
  await ensureColumn('bot_users', 'verified_at', 'TEXT');
  await ensureColumn('withdrawal_requests', 'approved_at', 'TEXT');
}

async function upsertUser(userId, { lang = null, phone = null, contractorProfileId = null } = {}) {
  await run(
    `
    INSERT INTO bot_users (user_id, lang, phone, contractor_profile_id, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      lang = COALESCE(excluded.lang, bot_users.lang),
      phone = COALESCE(excluded.phone, bot_users.phone),
      contractor_profile_id = COALESCE(excluded.contractor_profile_id, bot_users.contractor_profile_id),
      updated_at = CURRENT_TIMESTAMP;
  `,
    [userId, lang, phone, contractorProfileId]
  );
}

async function getUser(userId) {
  return get(
    `SELECT user_id, lang, phone, contractor_profile_id, verified_at FROM bot_users WHERE user_id = ?`,
    [userId]
  );
}

async function setUserLang(userId, lang) {
  await upsertUser(userId, { lang });
}

async function setUserPhone(userId, phone) {
  await upsertUser(userId, { phone });
}

async function setUserContractorProfileId(userId, contractorProfileId) {
  await upsertUser(userId, { contractorProfileId });
}

async function setUserVerifiedAt(userId, verifiedAt) {
  await upsertUser(userId, {});
  await run(`UPDATE bot_users SET verified_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [
    verifiedAt,
    userId,
  ]);
}

async function clearUserSession(userId) {
  await upsertUser(userId, {});
  await run(
    `UPDATE bot_users SET phone = NULL, contractor_profile_id = NULL, verified_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    [userId]
  );
}

async function setDefaultCard(userId, cardNumber, cardName) {
  await upsertUser(userId, {});
  await run(`UPDATE user_cards SET is_default = 0 WHERE user_id = ?`, [userId]);
  await run(
    `INSERT INTO user_cards (user_id, card_number, card_name, is_default) VALUES (?, ?, ?, 1)`,
    [userId, cardNumber, cardName]
  );
}

async function getDefaultCard(userId) {
  return get(
    `SELECT card_number, card_name
     FROM user_cards
     WHERE user_id = ? AND is_default = 1
     ORDER BY id DESC
     LIMIT 1`,
    [userId]
  );
}

async function listUserCards(userId) {
  return all(
    `SELECT id, card_number, card_name, is_default, created_at
     FROM user_cards
     WHERE user_id = ?
     ORDER BY is_default DESC, id DESC`,
    [userId]
  );
}

async function setDefaultCardById(userId, cardId) {
  await upsertUser(userId, {});
  await run(`UPDATE user_cards SET is_default = 0 WHERE user_id = ?`, [userId]);
  await run(`UPDATE user_cards SET is_default = 1 WHERE user_id = ? AND id = ?`, [userId, cardId]);
}

async function createWithdrawal(token, payload) {
  const { userId, phone, cardNumber, cardName, amount, currency, approvedBy = null, status = 'pending' } = payload;

  await upsertUser(userId, { phone });
  await run(
    `
    INSERT INTO withdrawal_requests
      (token, user_id, phone, card_number, card_name, amount, currency, status, approved_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `,
    [token, userId, phone, cardNumber, cardName, amount, currency, status, approvedBy]
  );
}

async function getWithdrawal(token) {
  return get(`SELECT * FROM withdrawal_requests WHERE token = ?`, [token]);
}

async function updateWithdrawal(token, fields) {
  const allowed = ['status', 'reject_reason', 'receipt_file_id', 'approved_by', 'approved_at', 'updated_at'];
  const keys = Object.keys(fields || {}).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;

  const sets = [];
  const values = [];
  for (const k of keys) {
    if (k === 'updated_at') continue; // we always set it ourselves below
    sets.push(`${k} = ?`);
    values.push(toSqlValue(fields[k]));
  }
  sets.push(`updated_at = CURRENT_TIMESTAMP`);

  await run(`UPDATE withdrawal_requests SET ${sets.join(', ')} WHERE token = ?`, [...values, token]);
}

async function listWithdrawalsByPhone(phone, { limit = 10, offset = 0, statuses = null } = {}) {
  const hasStatuses = Array.isArray(statuses) && statuses.length > 0;

  const where = ['phone = ?'];
  const params = [phone];
  if (hasStatuses) {
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }

  params.push(limit, offset);
  return all(
    `
    SELECT token, user_id, phone, card_number, card_name, amount, currency, status, reject_reason,
           receipt_file_id, approved_by, approved_at, created_at, updated_at
    FROM withdrawal_requests
    WHERE ${where.join(' AND ')}
    ORDER BY datetime(created_at) DESC
    LIMIT ? OFFSET ?
  `,
    params
  );
}

async function countWithdrawalsByPhone(phone, { statuses = null } = {}) {
  const hasStatuses = Array.isArray(statuses) && statuses.length > 0;

  const where = ['phone = ?'];
  const params = [phone];
  if (hasStatuses) {
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }

  const row = await get(`SELECT COUNT(*) AS cnt FROM withdrawal_requests WHERE ${where.join(' AND ')}`, params);
  return Number(row?.cnt || 0);
}

// Compatibility helper (similar-ish to pg's { rows })
async function query(sql, params) {
  const s = String(sql || '').trim().toLowerCase();
  if (s.startsWith('select') || s.startsWith('pragma')) {
    const rows = await all(sql, params);
    return { rows };
  }
  const res = await run(sql, params);
  return { rows: [], ...res };
}

module.exports = {
  init,
  query,
  getUser,
  setUserLang,
  setUserPhone,
  setUserContractorProfileId,
  setUserVerifiedAt,
  clearUserSession,
  getDefaultCard,
  listUserCards,
  setDefaultCardById,
  setDefaultCard,
  createWithdrawal,
  getWithdrawal,
  updateWithdrawal,
  listWithdrawalsByPhone,
  countWithdrawalsByPhone,
};

