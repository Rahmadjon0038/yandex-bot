const axios = require('axios');

function must(value, name) {
  if (!value || String(value).trim() === '') {
    throw new Error(`Missing required config: ${name}`);
  }
  return String(value).trim();
}

function getParkId() {
  return process.env.YANDEX_PARK_ID || null;
}

function getClientId(parkId) {
  return process.env.YANDEX_CLIENT_ID || `taxi/park/${parkId}`;
}

function getApiKey() {
  return process.env.YANDEX_API_KEY || null;
}

function getBaseUrl() {
  return (process.env.YANDEX_FLEET_BASE_URL || 'https://fleet-api.taxi.yandex.net').replace(/\/+$/, '');
}

function isTransactionsEnabled() {
  return String(process.env.YANDEX_TRANSACTIONS_ENABLED || '').toLowerCase() === 'true';
}

function toAmount4(value) {
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num)) throw new Error('Invalid amount');
  const fixed = num.toFixed(4);
  if (fixed === '-0.0000') return '0.0000';
  return fixed;
}

async function postJson(path, body, { parkId, idempotencyToken } = {}) {
  const resolvedParkId = parkId || getParkId();
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();

  const finalParkId = must(resolvedParkId, 'YANDEX_PARK_ID (or parkId param)');
  const finalApiKey = must(apiKey, 'YANDEX_API_KEY');
  const clientId = must(getClientId(finalParkId), 'YANDEX_CLIENT_ID');

  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': finalApiKey,
    'X-Client-ID': clientId,
  };
  if (idempotencyToken) headers['X-Idempotency-Token'] = String(idempotencyToken);

  return axios.post(`${baseUrl}${path}`, body, { headers });
}

async function createDriverProfileTransaction({
  amount,
  contractorProfileId,
  parkId,
  description,
  kind,
  idempotencyToken,
  feeAmount,
}) {
  if (!isTransactionsEnabled()) {
    return {
      disabled: true,
      request: {
        amount: toAmount4(amount),
        park_id: parkId || getParkId(),
        contractor_profile_id: contractorProfileId,
        description: description || '',
        data: kind ? { kind } : undefined,
      },
    };
  }

  const amt = toAmount4(amount);
  const payload = {
    amount: amt,
    park_id: must(parkId || getParkId(), 'YANDEX_PARK_ID'),
    contractor_profile_id: must(contractorProfileId, 'contractorProfileId'),
    description: description || '',
    data: {
      kind: must(kind, 'kind'),
    },
  };

  // Yandex' payout namunasiga mos: payout_amount ham yuboriladi
  if (kind === 'payout') {
    payload.data.payout_amount = amt;
    // Fleet API ko'pincha fee_amount talab qiladi (komissiya). Default 0.0000.
    payload.data.fee_amount = toAmount4(feeAmount ?? 0);
  }

  const res = await postJson('/v3/parks/driver-profiles/transactions', payload, {
    parkId: payload.park_id,
    idempotencyToken,
  });
  return res.data;
}

module.exports = {
  getParkId,
  getClientId,
  getApiKey,
  isTransactionsEnabled,
  createDriverProfileTransaction,
  toAmount4,
};
