const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  pool = new Pool(
    connectionString
      ? { connectionString }
      : {
          host: process.env.PGHOST || 'localhost',
          port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          database: process.env.PGDATABASE,
        }
  );

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function init() {
  // users: til, telefon va default karta
  await query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      user_id BIGINT PRIMARY KEY,
      lang TEXT,
      phone TEXT,
      contractor_profile_id TEXT,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Eski DBlarda column bo'lmasa qo'shish
  await query(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS contractor_profile_id TEXT;`);
  await query(`ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;`);

  await query(`
    CREATE TABLE IF NOT EXISTS user_cards (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES bot_users(user_id) ON DELETE CASCADE,
      card_number TEXT NOT NULL,
      card_name TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES bot_users(user_id) ON DELETE CASCADE,
      phone TEXT,
      card_number TEXT NOT NULL,
      card_name TEXT NOT NULL,
      amount NUMERIC(18,2) NOT NULL,
      currency TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      receipt_file_id TEXT,
      approved_by BIGINT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;`);
}

async function upsertUser(userId, { lang = null, phone = null, contractorProfileId = null } = {}) {
  await query(
    `
    INSERT INTO bot_users (user_id, lang, phone, contractor_profile_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id) DO UPDATE
      SET lang = COALESCE(EXCLUDED.lang, bot_users.lang),
          phone = COALESCE(EXCLUDED.phone, bot_users.phone),
          contractor_profile_id = COALESCE(EXCLUDED.contractor_profile_id, bot_users.contractor_profile_id),
          updated_at = now();
  `,
    [userId, lang, phone, contractorProfileId]
  );
}

async function getUser(userId) {
  const res = await query(`SELECT user_id, lang, phone, contractor_profile_id, verified_at FROM bot_users WHERE user_id = $1`, [userId]);
  return res.rows[0] || null;
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
  await query(`UPDATE bot_users SET verified_at = $2, updated_at = now() WHERE user_id = $1`, [
    userId,
    verifiedAt,
  ]);
}

async function clearUserSession(userId) {
  await upsertUser(userId, {});
  await query(
    `UPDATE bot_users SET phone = NULL, contractor_profile_id = NULL, verified_at = NULL, updated_at = now() WHERE user_id = $1`,
    [userId]
  );
}

async function setDefaultCard(userId, cardNumber, cardName) {
  await upsertUser(userId, {});
  await query(`UPDATE user_cards SET is_default = false WHERE user_id = $1`, [userId]);
  await query(
    `INSERT INTO user_cards (user_id, card_number, card_name, is_default) VALUES ($1, $2, $3, true)`,
    [userId, cardNumber, cardName]
  );
}

async function getDefaultCard(userId) {
  const res = await query(
    `SELECT card_number, card_name FROM user_cards WHERE user_id = $1 AND is_default = true ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function listUserCards(userId) {
  const res = await query(
    `SELECT id, card_number, card_name, is_default, created_at
     FROM user_cards
     WHERE user_id = $1
     ORDER BY is_default DESC, id DESC`,
    [userId]
  );
  return res.rows;
}

async function setDefaultCardById(userId, cardId) {
  await upsertUser(userId, {});
  await query(`UPDATE user_cards SET is_default = false WHERE user_id = $1`, [userId]);
  await query(`UPDATE user_cards SET is_default = true WHERE user_id = $1 AND id = $2`, [userId, cardId]);
}

async function createWithdrawal(token, payload) {
  const {
    userId,
    phone,
    cardNumber,
    cardName,
    amount,
    currency,
    approvedBy = null,
    status = 'pending',
  } = payload;

  await upsertUser(userId, { phone });
  await query(
    `
    INSERT INTO withdrawal_requests
      (token, user_id, phone, card_number, card_name, amount, currency, status, approved_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `,
    [token, userId, phone, cardNumber, cardName, amount, currency, status, approvedBy]
  );
}

async function getWithdrawal(token) {
  const res = await query(`SELECT * FROM withdrawal_requests WHERE token = $1`, [token]);
  return res.rows[0] || null;
}

async function updateWithdrawal(token, fields) {
  const allowed = [
    'status',
    'reject_reason',
    'receipt_file_id',
    'approved_by',
    'approved_at',
    'updated_at',
  ];
  const keys = Object.keys(fields || {}).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;

  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => fields[k]);
  await query(`UPDATE withdrawal_requests SET ${sets.join(', ')}, updated_at = now() WHERE token = $1`, [
    token,
    ...values,
  ]);
}

async function listWithdrawalsByPhone(phone, { limit = 10, offset = 0, statuses = null } = {}) {
  const hasStatuses = Array.isArray(statuses) && statuses.length > 0;
  const res = await query(
    `
    SELECT token, user_id, phone, card_number, card_name, amount, currency, status, reject_reason,
           receipt_file_id, approved_by, approved_at, created_at, updated_at
    FROM withdrawal_requests
    WHERE phone = $1
      AND ($4::text[] IS NULL OR status = ANY($4::text[]))
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `,
    [phone, limit, offset, hasStatuses ? statuses : null]
  );
  return res.rows;
}

async function countWithdrawalsByPhone(phone, { statuses = null } = {}) {
  const hasStatuses = Array.isArray(statuses) && statuses.length > 0;
  const res = await query(
    `SELECT COUNT(*)::int AS cnt FROM withdrawal_requests WHERE phone = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))`,
    [phone, hasStatuses ? statuses : null]
  );
  return res.rows[0]?.cnt ?? 0;
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
