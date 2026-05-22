const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const yandexFleet = require('./config/yandexFleet');

function normalizeBotToken(raw) {
  let token = String(raw || '').trim();
  if (!token) return null;

  // Common .env patterns: BOTTOKEN="123:ABC" or BOTTOKEN='123:ABC'
  if (
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
  ) {
    token = token.slice(1, -1).trim();
  }

  // Defensive: remove stray CR from Windows line endings.
  token = token.replace(/\r/g, '');

  return token || null;
}

function validateBotToken(token) {
  // Telegram token shape: "<digits>:<url-safe chars>"
  if (/\s/.test(token)) return { ok: false, reason: 'contains whitespace' };
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    const bad = [];
    for (let i = 0; i < token.length; i++) {
      const ch = token[i];
      if (!/[0-9A-Za-z:_-]/.test(ch)) bad.push({ i, code: ch.codePointAt(0) });
    }
    return { ok: false, reason: `contains invalid characters at positions: ${bad.map((b) => `${b.i}(U+${b.code.toString(16).toUpperCase().padStart(4, '0')})`).join(', ') || 'unknown'}` };
  }
  return { ok: true };
}

// Bot tokenini .env faylidan olish
let botToken = normalizeBotToken(process.env.BOTTOKEN);
if (!botToken) {
  throw new Error("BOTTOKEN noto‘g‘ri: bo‘sh. `.env` dagi `BOTTOKEN=...` ni tekshiring.");
}

let tokenCheck = validateBotToken(botToken);
if (!tokenCheck.ok) {
  const cleaned = botToken.replace(/[^0-9A-Za-z:_-]/g, '');
  if (cleaned && cleaned !== botToken) {
    const retry = validateBotToken(cleaned);
    if (retry.ok) {
      console.warn('BOTTOKEN ichidan keraksiz/invisible belgilar olib tashlandi (auto-fix). `.env` dagi tokenni qayta kiritish tavsiya etiladi.');
      botToken = cleaned;
      tokenCheck = retry;
    }
  }
}
if (!tokenCheck.ok) {
  throw new Error(
    `BOTTOKEN noto‘g‘ri: ${tokenCheck.reason}. `.env` dagi BOTTOKEN qiymatini qayta yozib chiqing (ko‘pincha invisible belgilar yoki qo‘shtirnoqlar sabab bo‘ladi).`
  );
}

const bot = new TelegramBot(botToken, { polling: true });

// Yandex API uchun konfiguratsiya
const YANDEX_API_URL = 'https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list';
const PARK_ID = process.env.YANDEX_PARK_ID || '98d550d2a0684e90a6a59577e43d2f46';
const CLIENT_ID = process.env.YANDEX_CLIENT_ID || 'taxi/park/' + PARK_ID;
const ADMIN_USER_IDS = new Set([6971915586,5685157267]);
const pendingWithdrawals = new Map(); // legacy/fallback when DB is off
const adminStates = new Map(); // adminId -> { step: 'reject_reason'|'await_receipt', token }

let db = null;
let dbReady = false;
try {
  db = require('./config/db');
} catch (e) {
  console.error('DB modulini yuklab bo‘lmadi (sqlite3 o‘rnatilmagan bo‘lishi mumkin).', e?.message || e);
}

async function initDb() {
  if (!db) return;
  try {
    await db.init();
    dbReady = true;
    console.log('DB tayyor (tables created).');
  } catch (e) {
    console.error('DB init xatosi:', e?.message || e);
  }
}

initDb();

bot.on('polling_error', (err) => {
  // Ko'pincha bu bir vaqtning o'zida 2 ta bot process ishlaganda (409) chiqadi
  console.error('polling_error:', err?.code, err?.message || err);
  if (err?.stack) console.error(err.stack);
});

bot.on('webhook_error', (err) => {
  console.error('webhook_error:', err?.code, err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason?.stack || reason);
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err?.stack || err);
});

const PREFS_PATH = path.join(__dirname, 'user_prefs.json');
function loadUserPrefs() {
  try {
    const raw = fs.readFileSync(PREFS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveUserPrefs(prefs) {
  fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8');
}

const userPrefs = loadUserPrefs();

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24);
const SESSION_TTL_MS =
  (Number.isFinite(SESSION_TTL_HOURS) && SESSION_TTL_HOURS > 0 ? SESSION_TTL_HOURS : 24) * 60 * 60 * 1000;

const i18n = {
  uz: {
    langName: "O'zbek",
    chooseLang: "Muloqot tilini tanlang:",
    welcome: `Assalomu alaykum. "Hilol" taksoparkining avtomatlashtirilgan xizmat ko'rsatish botiga xush kelibsiz.

Ushbu bot haydovchilar uchun quyidagi qulayliklarni taqdim etadi:
• Joriy hisob (balans) holatini bilish;
• Mablag'larni bank kartasiga yechib olish;

Xizmatlardan foydalanish uchun profilingizni tasdiqlashingiz kerak. Iltimos, ekranning pastki qismidagi "📱 Raqamni yuborish" tugmasini bosing.`,
    sendPhone: "📱 Raqamni yuborish",
    // typePhone removed: only Telegram contact share is allowed
    onlyOwnContact: "Iltimos, faqat o'zingizning raqamingizni yuboring.",
    notFound:
      "Kechirasiz, siz yuborgan telefon raqami taksopark (Yandex) bazasida topilmadi.\n\n" +
      "Pul yechish / balansni ko‘rish faqat Telegram’da yuborgan raqamingiz taksoparkdagi haydovchi profilingizdagi raqam bilan 100% mos bo‘lsa ishlaydi.\n\n" +
      "Iltimos, adminga murojaat qiling va taksopark bazasidagi telefon raqamingizni yangilab berishini so‘rang. Raqam yangilangandan keyin botga qayta /start qiling va telefon raqamingizni yana yuboring — shunda yechib olish ishlaydi.",
    genericError: "Xatolik yuz berdi. Iltimos, keyinroq urinib ko'ring.",
    profileMessage: ({ firstName, lastName, formattedPhone, formattedBalance, currency, brand, model, number, callsign, driverLicense }) =>
      `👤 Ism: ${firstName}\n👥 Familiya: ${lastName}\n🆔 Haydovchi ID: ${callsign}\n📱 Telefon: ${formattedPhone}\n📋 Guvohnomasining raqami: ${driverLicense}\n\n🚗 Avtomobil:\n  • Marka: ${brand}\n  • Model: ${model}\n  • Davlat raqami: ${number}\n\n💰 Balans: ${formattedBalance} ${currency}`,
    withdrawBtn: "💸 Pul yechib olish",
    topupBtn: "➕ Balansni to'ldirish",
    withdrawInfo: "Pul yechib olish bo'limi hozircha ulanmagan. Keyingi bosqichda qo'shamiz.",
    topupInfo: "Balansni to'ldirish bo'limi hozircha ulanmagan. Keyingi bosqichda qo'shamiz.",
    myBalanceBtn: "💰 Mening balansim",
    logoutBtn: "🚪 Chiqish",
    myCardsBtn: "💳 Mening kartalarim",
    cardsTitle: "💳 Mening kartalarim",
    noCards: "Sizda saqlangan karta yo'q. Yangi karta qo'shing.",
    addNewCardBtn: "➕ Yangi karta qo'shish",
    setDefaultCardBtn: "⭐ Asosiy qilish",
    cardSaved: "✅ Karta saqlandi.",
    chooseSavedCard: (cardNumber, cardName) =>
      `Saqlangan karta:\n💳 ${cardNumber}\n🧑‍💼 ${cardName}\n\nShu kartadan foydalansizmi yoki boshqa karta kiritasizmi?`,
    useSavedCardBtn: "✅ Shu karta",
    otherCardBtn: "✍️ Boshqa karta",
    noPhoneSaved: "Balansni ko'rish uchun avval raqamingizni tasdiqlang (kontakt yuboring).",
    loginRequired:
      "Xizmatdan foydalanish uchun avval tizimga kiring.\n\n" +
      "Iltimos, \"📱 Raqamni yuborish\" tugmasi orqali telefon raqamingizni yuboring.",
    sessionExpired:
      "Sessiya muddati tugagan.\n\n" +
      "Xavfsizlik uchun har 24 soatda qayta login qilish kerak. Iltimos, \"📱 Raqamni yuborish\" orqali telefon raqamingizni yana tasdiqlang.",
    loggedOut:
      "Siz akkauntdan chiqdingiz.\n\n" +
      "Qayta kirish uchun \"📱 Raqamni yuborish\" tugmasi orqali telefon raqamingizni tasdiqlang.",
    balanceOnly: ({ formattedBalance, currency }) => `💰 Balansingiz: ${formattedBalance} ${currency}`,
    enterCardNumber: "Karta raqamingizni kiriting (16 xonali):",
    invalidCardNumber: "Karta raqami noto'g'ri. 16 xonali raqam kiriting (masalan: 8600 1234 5678 9012).",
    enterCardName: "Karta ustidagi ism-familiyani kiriting (masalan: ALIJONOV MUNISJON):",
    invalidCardName: "Ism-familiya juda qisqa. Qaytadan kiriting.",
    enterWithdrawAmount: "Yechib olmoqchi bo'lgan summani kiriting (so'm):",
    invalidAmount: "Summa noto'g'ri. Faqat raqam kiriting.",
    insufficientFunds: ({ formattedBalance, currency }) => `Sizning hisobingizda ${formattedBalance} ${currency} bor. Iltimos, shu miqdordan oshmaydigan summa kiriting.`,
    withdrawRequestSent: "So'rovingiz adminga yuborildi. Admin tasdiqlaganidan keyin amaliyot bajariladi.",
    withdrawApproved: "Admin tasdiqladi. Amaliyot bajarilmoqda.",
    withdrawRejected: "Admin rad etdi. Iltimos, keyinroq urinib ko'ring yoki adminga murojaat qiling.",
    withdrawRejectedWithReason: (reason) => `Admin rad etdi.\nSabab: ${reason}`,
    withdrawReceiptCaption: "✅ Pul yechish amaliyoti bajarildi. Chek:",
    adminNewWithdraw: ({
      driverFirstName,
      driverLastName,
      driverLicense,
      driverId,
      phone,
      carBrand,
      carModel,
      carNumber,
      contractorProfileId,
      cardNumber,
      cardName,
      formattedBalance,
      currency,
      amountFormatted,
    }) =>
      `🧾 Yangi pul yechish so'rovi\n\n` +
      `👤 Ism: ${driverFirstName || "Noma'lum"}\n` +
      `👥 Familiya: ${driverLastName || "Noma'lum"}\n` +
      `🆔 Haydovchi ID: ${driverId || '-'}\n` +
      `📱 Telefon: ${phone || '-'}\n` +
      `📋 Guvohnomaning raqami: ${driverLicense || '-'}\n` +
      `🚗 Avtomobil:\n` +
      `  • Marka: ${carBrand || '-'}\n` +
      `  • Model: ${carModel || '-'}\n` +
      `  • Davlat raqami: ${carNumber || '-'}\n` +
      (contractorProfileId ? `🧾 Contractor ID: ${contractorProfileId}\n` : '') +
      `💳 Karta: ${cardNumber}\n` +
      `🧑‍💼 Karta Egasi: ${cardName}\n` +
      `💰 Balans: ${formattedBalance} ${currency}\n` +
      `💸 So'ralgan: ${amountFormatted} ${currency}`,
    adminApprove: "✅ Tasdiqlash",
    adminReject: "❌ Rad etish",
    adminAskRejectReason: "Rad qilish sababi bo'lsa yozib yuboring (ixtiyoriy). Sababsiz rad qilish uchun /skip yozing.",
    adminAskReceipt: "Tasdiqlandi. Endi chek rasmini yuboring (photo). Cheksiz yakunlash uchun /skip bosing.",
    adminDone: "✅ Tayyor. Foydalanuvchiga yuborildi.",
    adminNotFound: "So'rov topilmadi yoki allaqachon yakunlangan.",
    adminTxnDisabled: "⚠️ Yandex tranzaksiyalar o'chirilgan (`YANDEX_TRANSACTIONS_ENABLED=true` qilib yoqing).",
    adminTxnFailed: "❌ Yandex tranzaksiya xatosi. Iltimos, log'ni tekshiring va qayta urinib ko'ring.",
    userTxnFailed: "❌ Operatsiya bajarilmadi. Admin bilan bog'laning.",
    adminPanelTitle: "🛠 Admin panel",
    adminPanelBtn: "🛠 Admin panel",
    adminDriversBtn: "👥 Barcha hodimlar",
    adminBackBtn: "⬅️ Orqaga",
    adminHistoryBtn: "📜 Tranzaksiyalar tarixi",
    adminNoHistory: "Bu haydovchi bo‘yicha tranzaksiyalar topilmadi.",
    adminDbRequired: "DB ulanmagan. Admin panel uchun SQLite3 kerak.",
    status_pending: "Kutilmoqda",
    status_await_receipt: "Chek kutilmoqda",
    status_await_reject_reason: "Sabab kutilmoqda",
    status_rejected: "Rad etilgan",
    status_completed: "Bajarilgan",
    status_txn_failed: "Xatolik",
    needLangFirst: "Davom etish uchun avval muloqot tilini tanlang. /start bosing.",
    locale: 'uz-UZ',
  },
  ru: {
    langName: 'Русский',
    chooseLang: 'Выберите язык общения:',
    welcome: `Здравствуйте! Добро пожаловать в автоматизированный сервисный бот таксопарка "Hilol".

Этот бот предоставляет водителям следующие возможности:
• Узнать состояние текущего счёта (баланс);
• Вывести средства на банковскую карту;
• Контролировать данные профиля.

Для использования сервиса необходимо подтвердить ваш профиль. Нажмите кнопку "📱 Отправить номер" внизу экрана.`,
    sendPhone: '📱 Отправить номер',
    // typePhone removed: only Telegram contact share is allowed
    onlyOwnContact: 'Пожалуйста, отправьте только свой номер.',
    notFound: 'К сожалению, ваш номер не найден в базе таксопарка. Пожалуйста, обратитесь к администратору.',
    genericError: 'Произошла ошибка. Пожалуйста, попробуйте позже.',
    profileMessage: ({ firstName, lastName, formattedPhone, formattedBalance, currency, brand, model, number, callsign, driverLicense }) =>
      `👤 Имя: ${firstName}\n👥 Фамилия: ${lastName}\n🆔 ID водителя: ${callsign}\n📱 Телефон: ${formattedPhone}\n📋 Номер водительского удостоверения: ${driverLicense}\n\n🚗 Автомобиль:\n  • Марка: ${brand}\n  • Модель: ${model}\n  • Регистрационный номер: ${number}\n\n💰 Баланс: ${formattedBalance} ${currency}`,
    withdrawBtn: "💸 Вывод средств",
    topupBtn: "➕ Пополнить баланс",
    withdrawInfo: "Раздел вывода средств пока не подключён. Добавим на следующем этапе.",
    topupInfo: "Раздел пополнения баланса пока не подключён. Добавим на следующем этапе.",
    myBalanceBtn: "💰 Мой баланс",
    logoutBtn: "🚪 Выйти",
    myCardsBtn: "💳 Мои карты",
    cardsTitle: "💳 Мои карты",
    noCards: "У вас нет сохранённых карт. Добавьте новую карту.",
    addNewCardBtn: "➕ Добавить карту",
    setDefaultCardBtn: "⭐ Сделать основной",
    cardSaved: "✅ Карта сохранена.",
    chooseSavedCard: (cardNumber, cardName) =>
      `Сохранённая карта:\n💳 ${cardNumber}\n🧑‍💼 ${cardName}\n\nИспользовать эту карту или ввести другую?`,
    useSavedCardBtn: "✅ Эта карта",
    otherCardBtn: "✍️ Другая карта",
    noPhoneSaved: "Чтобы посмотреть баланс, сначала подтвердите номер (отправьте контакт).",
    loginRequired:
      "Чтобы продолжить, сначала войдите в систему.\n\n" +
      "Пожалуйста, отправьте номер через кнопку \"📱 Отправить номер\".",
    sessionExpired:
      "Срок сессии истёк.\n\n" +
      "Для безопасности нужно заново войти каждые 24 часа. Подтвердите номер через \"📱 Отправить номер\".",
    loggedOut:
      "Вы вышли из аккаунта.\n\n" +
      "Чтобы войти снова, подтвердите номер через \"📱 Отправить номер\".",
    balanceOnly: ({ formattedBalance, currency }) => `💰 Ваш баланс: ${formattedBalance} ${currency}`,
    enterCardNumber: "Введите номер карты (16 цифр):",
    invalidCardNumber: "Неверный номер карты. Введите 16 цифр (например: 8600 1234 5678 9012).",
    enterCardName: "Введите имя и фамилию как на карте (например: ALIJONOV MUNISJON):",
    invalidCardName: "Имя/фамилия слишком короткие. Попробуйте ещё раз.",
    enterWithdrawAmount: "Введите сумму для вывода (сум):",
    invalidAmount: "Неверная сумма. Введите только число.",
    insufficientFunds: ({ formattedBalance, currency }) => `У вас на счету ${formattedBalance} ${currency}. Введите сумму не больше этого значения.`,
    withdrawRequestSent: "Ваш запрос отправлен администратору на подтверждение. После подтверждения операция будет выполнена.",
    withdrawApproved: "Администратор подтвердил. Операция выполняется.",
    withdrawRejected: "Администратор отклонил запрос. Попробуйте позже или обратитесь к администратору.",
    withdrawRejectedWithReason: (reason) => `Администратор отклонил запрос.\nПричина: ${reason}`,
    withdrawReceiptCaption: "✅ Операция выполнена. Чек:",
    adminNewWithdraw: ({
      driverFirstName,
      driverLastName,
      driverLicense,
      driverId,
      phone,
      carBrand,
      carModel,
      carNumber,
      contractorProfileId,
      cardNumber,
      cardName,
      formattedBalance,
      currency,
      amountFormatted,
    }) =>
      `🧾 Новый запрос на вывод средств\n\n` +
      `👤 Имя: ${driverFirstName || 'Неизвестно'}\n` +
      `👥 Фамилия: ${driverLastName || 'Неизвестно'}\n` +
      `🆔 ID водителя: ${driverId || '-'}\n` +
      `📱 Телефон: ${phone || '-'}\n` +
      `📋 Номер водительского удостоверения: ${driverLicense || '-'}\n` +
      `🚗 Автомобиль:\n` +
      `  • Марка: ${carBrand || '-'}\n` +
      `  • Модель: ${carModel || '-'}\n` +
      `  • Регистрационный номер: ${carNumber || '-'}\n` +
      (contractorProfileId ? `🧾 Contractor ID: ${contractorProfileId}\n` : '') +
      `💳 Карта: ${cardNumber}\n` +
      `🧑‍💼 Владелец: ${cardName}\n` +
      `💰 Баланс: ${formattedBalance} ${currency}\n` +
      `💸 Запрошено: ${amountFormatted} ${currency}`,
    adminApprove: "✅ Подтвердить",
    adminReject: "❌ Отклонить",
    adminAskRejectReason: "Напишите причину отказа (необязательно). Чтобы отказать без причины, отправьте /skip.",
    adminAskReceipt: "Подтверждено. Теперь отправьте фото чека. Чтобы завершить без чека, отправьте /skip.",
    adminDone: "✅ Готово. Отправлено пользователю.",
    adminNotFound: "Запрос не найден или уже завершён.",
    adminTxnDisabled: "⚠️ Транзакции Yandex выключены (включите `YANDEX_TRANSACTIONS_ENABLED=true`).",
    adminTxnFailed: "❌ Ошибка транзакции Yandex. Проверьте логи и попробуйте снова.",
    userTxnFailed: "❌ Операция не выполнена. Свяжитесь с администратором.",
    adminPanelTitle: "🛠 Админ-панель",
    adminPanelBtn: "🛠 Админ-панель",
    adminDriversBtn: "👥 Все сотрудники",
    adminBackBtn: "⬅️ Назад",
    adminHistoryBtn: "📜 История транзакций",
    adminNoHistory: "По этому водителю транзакции не найдены.",
    adminDbRequired: "DB не подключена. Для админ-панели нужен SQLite3.",
    status_pending: "В ожидании",
    status_await_receipt: "Ожидается чек",
    status_await_reject_reason: "Ожидается причина",
    status_rejected: "Отклонено",
    status_completed: "Выполнено",
    status_txn_failed: "Ошибка",
    needLangFirst: 'Чтобы продолжить, сначала выберите язык. Нажмите /start.',
    locale: 'ru-RU',
  },
  en: {
    langName: 'English',
    chooseLang: 'Choose your language:',
    welcome: `Hello! Welcome to the "Hilol" taxi park automated service bot.

This bot provides drivers with:
• Checking current account balance;
• Withdrawing funds to a bank card;
• Monitoring profile details.

To use the services, you need to verify your profile. Tap "📱 Send phone number" below.`,
    sendPhone: '📱 Send phone number',
    // typePhone removed: only Telegram contact share is allowed
    onlyOwnContact: 'Please send only your own phone number.',
    notFound: 'Sorry, your number was not found in the taxi park database. Please contact the admin.',
    genericError: 'An error occurred. Please try again later.',
    profileMessage: ({ firstName, lastName, formattedPhone, formattedBalance, currency, brand, model, number, callsign, driverLicense }) =>
      `👤 Name: ${firstName}\n👥 Last Name: ${lastName}\n🆔 Driver ID: ${callsign}\n📱 Phone: ${formattedPhone}\n📋 Driver License: ${driverLicense}\n\n🚗 Vehicle:\n  • Brand: ${brand}\n  • Model: ${model}\n  • Registration Number: ${number}\n\n💰 Balance: ${formattedBalance} ${currency}`,
    withdrawBtn: "💸 Withdraw",
    topupBtn: "➕ Top up balance",
    withdrawInfo: "Withdraw feature is not connected yet. We'll add it in the next step.",
    topupInfo: "Top up feature is not connected yet. We'll add it in the next step.",
    myBalanceBtn: "💰 My balance",
    logoutBtn: "🚪 Log out",
    myCardsBtn: "💳 My cards",
    cardsTitle: "💳 My cards",
    noCards: "You have no saved cards. Add a new card.",
    addNewCardBtn: "➕ Add new card",
    setDefaultCardBtn: "⭐ Set default",
    cardSaved: "✅ Card saved.",
    chooseSavedCard: (cardNumber, cardName) =>
      `Saved card:\n💳 ${cardNumber}\n🧑‍💼 ${cardName}\n\nUse this card or enter another one?`,
    useSavedCardBtn: "✅ Use this card",
    otherCardBtn: "✍️ Other card",
    noPhoneSaved: "To view balance, please verify your phone first (send your contact).",
    loginRequired:
      "To continue, please log in first.\n\n" +
      "Send your phone number via \"📱 Send phone number\".",
    sessionExpired:
      "Your session has expired.\n\n" +
      "For security, you need to log in again every 24 hours. Please verify your phone via \"📱 Send phone number\".",
    loggedOut:
      "You are logged out.\n\n" +
      "To log in again, verify your phone via \"📱 Send phone number\".",
    balanceOnly: ({ formattedBalance, currency }) => `💰 Your balance: ${formattedBalance} ${currency}`,
    enterCardNumber: "Enter your card number (16 digits):",
    invalidCardNumber: "Invalid card number. Enter 16 digits (example: 8600 1234 5678 9012).",
    enterCardName: "Enter the cardholder name as on the card (example: ALIJONOV MUNISJON):",
    invalidCardName: "Cardholder name is too short. Please try again.",
    enterWithdrawAmount: "Enter the amount to withdraw (UZS):",
    invalidAmount: "Invalid amount. Enter numbers only.",
    insufficientFunds: ({ formattedBalance, currency }) => `Your balance is ${formattedBalance} ${currency}. Please enter an amount not greater than this.`,
    withdrawRequestSent: "Your request has been sent to the admin for approval. After approval, the operation will be processed.",
    withdrawApproved: "Admin approved. Processing the operation.",
    withdrawRejected: "Admin rejected the request. Please try later or contact admin.",
    withdrawRejectedWithReason: (reason) => `Admin rejected the request.\nReason: ${reason}`,
    withdrawReceiptCaption: "✅ Completed. Receipt:",
    adminNewWithdraw: ({
      driverFirstName,
      driverLastName,
      driverLicense,
      driverId,
      phone,
      carBrand,
      carModel,
      carNumber,
      contractorProfileId,
      cardNumber,
      cardName,
      formattedBalance,
      currency,
      amountFormatted,
    }) =>
      `🧾 New withdraw request\n\n` +
      `👤 First Name: ${driverFirstName || 'Unknown'}\n` +
      `👥 Last Name: ${driverLastName || 'Unknown'}\n` +
      `🆔 Driver ID: ${driverId || '-'}\n` +
      `📱 Phone: ${phone || '-'}\n` +
      `📋 Driver License: ${driverLicense || '-'}\n` +
      `🚗 Vehicle:\n` +
      `  • Brand: ${carBrand || '-'}\n` +
      `  • Model: ${carModel || '-'}\n` +
      `  • Registration Number: ${carNumber || '-'}\n` +
      (contractorProfileId ? `🧾 Contractor ID: ${contractorProfileId}\n` : '') +
      `💳 Card: ${cardNumber}\n` +
      `🧑‍💼 Name: ${cardName}\n` +
      `💰 Balance: ${formattedBalance} ${currency}\n` +
      `💸 Requested: ${amountFormatted} ${currency}`,
    adminApprove: "✅ Approve",
    adminReject: "❌ Reject",
    adminAskRejectReason: "Send a rejection reason (optional). To reject without a reason, send /skip.",
    adminAskReceipt: "Approved. Now send the receipt photo. To finish without a receipt, send /skip.",
    adminDone: "✅ Done. Sent to the user.",
    adminNotFound: "Request not found or already completed.",
    adminTxnDisabled: "⚠️ Yandex transactions are disabled (set `YANDEX_TRANSACTIONS_ENABLED=true`).",
    adminTxnFailed: "❌ Yandex transaction failed. Check logs and try again.",
    userTxnFailed: "❌ Operation failed. Please contact the admin.",
    adminPanelTitle: "🛠 Admin panel",
    adminPanelBtn: "🛠 Admin panel",
    adminDriversBtn: "👥 All drivers",
    adminBackBtn: "⬅️ Back",
    adminHistoryBtn: "📜 Transactions history",
    adminNoHistory: "No transactions found for this driver.",
    adminDbRequired: "DB is not connected. SQLite3 is required for admin panel.",
    status_pending: "Pending",
    status_await_receipt: "Awaiting receipt",
    status_await_reject_reason: "Awaiting reason",
    status_rejected: "Rejected",
    status_completed: "Completed",
    status_txn_failed: "Failed",
    needLangFirst: 'To continue, please choose a language first. Press /start.',
    locale: 'en-US',
  },
};

async function getUserRow(userId) {
  if (dbReady) {
    const row = await db.getUser(userId);
    if (row) return row;
    // lazily create user for later updates
    await db.setUserLang(userId, null);
    return db.getUser(userId);
  }
  const saved = userPrefs[String(userId)];
  if (typeof saved === 'string') return { user_id: userId, lang: saved, phone: null };
  if (saved && typeof saved === 'object') {
    return {
      user_id: userId,
      lang: saved.lang || null,
      phone: saved.phone || null,
      contractor_profile_id: saved.contractorProfileId || null,
      verified_at: saved.verifiedAt || null,
    };
  }
  return { user_id: userId, lang: null, phone: null, contractor_profile_id: null, verified_at: null };
}

async function getLang(userId) {
  const row = await getUserRow(userId);
  return row?.lang && i18n[row.lang] ? row.lang : null;
}

async function setLang(userId, lang) {
  if (dbReady) {
    await db.setUserLang(userId, lang);
    return;
  }
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object') {
    userPrefs[key] = { ...saved, lang };
  } else {
    userPrefs[key] = { lang };
  }
  saveUserPrefs(userPrefs);
}

async function getPhone(userId) {
  const row = await getUserRow(userId);
  return typeof row?.phone === 'string' ? row.phone : null;
}

async function getContractorProfileId(userId) {
  const row = await getUserRow(userId);
  return typeof row?.contractor_profile_id === 'string' && row.contractor_profile_id.trim()
    ? row.contractor_profile_id.trim()
    : null;
}

async function getVerifiedAt(userId) {
  const row = await getUserRow(userId);
  return row?.verified_at || null;
}

function parseTs(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

async function isSessionValid(userId) {
  const ts = parseTs(await getVerifiedAt(userId));
  if (!ts) return false;
  return Date.now() - ts.getTime() <= SESSION_TTL_MS;
}

async function getLoginKeyboard(userId) {
  return {
    reply_markup: {
      keyboard: [
        [{ text: await t(userId, 'sendPhone'), request_contact: true }],
      ],
      one_time_keyboard: true,
      resize_keyboard: true,
    },
  };
}

async function requireValidSession(chatId, userId) {
  const ts = parseTs(await getVerifiedAt(userId));
  if (!ts) {
    await bot.sendMessage(chatId, await t(userId, 'loginRequired'), await getLoginKeyboard(userId));
    return false;
  }

  const ok = Date.now() - ts.getTime() <= SESSION_TTL_MS;
  if (ok) return true;

  await bot.sendMessage(chatId, await t(userId, 'sessionExpired'), await getLoginKeyboard(userId));
  return false;
}

async function getDefaultCard(userId) {
  if (dbReady) {
    return db.getDefaultCard(userId);
  }
  const saved = userPrefs[String(userId)];
  if (saved && typeof saved === 'object' && saved.card && typeof saved.card === 'object') {
    const cardNumber = saved.card.cardNumber;
    const cardName = saved.card.cardName;
    if (typeof cardNumber === 'string' && typeof cardName === 'string') {
      return { card_number: cardNumber, card_name: cardName };
    }
  }
  return null;
}

async function setDefaultCard(userId, cardNumber, cardName) {
  if (dbReady) {
    return db.setDefaultCard(userId, cardNumber, cardName);
  }
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object') {
    userPrefs[key] = { ...saved, card: { cardNumber, cardName } };
  } else {
    userPrefs[key] = { lang: 'uz', card: { cardNumber, cardName } };
  }
  saveUserPrefs(userPrefs);
}

function getWithdrawState(userId) {
  const saved = userPrefs[String(userId)];
  if (saved && typeof saved === 'object' && saved.withdraw && typeof saved.withdraw === 'object') {
    return saved.withdraw;
  }
  return null;
}

function getCardFlowState(userId) {
  const saved = userPrefs[String(userId)];
  if (saved && typeof saved === 'object' && saved.cardFlow && typeof saved.cardFlow === 'object') {
    return saved.cardFlow;
  }
  return null;
}

function setCardFlowState(userId, cardFlow) {
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object') {
    userPrefs[key] = { ...saved, cardFlow };
  } else {
    userPrefs[key] = { lang: 'uz', cardFlow };
  }
  saveUserPrefs(userPrefs);
}

function clearCardFlowState(userId) {
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object' && saved.cardFlow) {
    const { cardFlow, ...rest } = saved;
    userPrefs[key] = rest;
    saveUserPrefs(userPrefs);
  }
}

function setWithdrawState(userId, withdraw) {
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object') {
    userPrefs[key] = { ...saved, withdraw };
  } else {
    userPrefs[key] = { lang: 'uz', withdraw };
  }
  saveUserPrefs(userPrefs);
}

function clearWithdrawState(userId) {
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object' && saved.withdraw) {
    const { withdraw, ...rest } = saved;
    userPrefs[key] = rest;
    saveUserPrefs(userPrefs);
  }
}

function setPhone(userId, formattedPhone) {
  if (dbReady) {
    return db.setUserPhone(userId, formattedPhone);
  }
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object') {
    userPrefs[key] = { ...saved, phone: formattedPhone };
  } else {
    userPrefs[key] = { lang: 'uz', phone: formattedPhone };
  }
  saveUserPrefs(userPrefs);
}

function setContractorProfileId(userId, contractorProfileId) {
  if (!contractorProfileId) return;
  if (dbReady) {
    return db.setUserContractorProfileId(userId, contractorProfileId);
  }
  const key = String(userId);
  const saved = userPrefs[key];
  if (saved && typeof saved === 'object') {
    userPrefs[key] = { ...saved, contractorProfileId };
  } else {
    userPrefs[key] = { lang: 'uz', contractorProfileId };
  }
  saveUserPrefs(userPrefs);
}

function setVerifiedNow(userId) {
  const now = new Date();
  if (dbReady) {
    return db.setUserVerifiedAt(userId, now);
  }
  const key = String(userId);
  const saved = userPrefs[key];
  const verifiedAt = now.toISOString();
  if (saved && typeof saved === 'object') {
    userPrefs[key] = { ...saved, verifiedAt };
  } else {
    userPrefs[key] = { lang: 'uz', verifiedAt };
  }
  saveUserPrefs(userPrefs);
}

async function clearSession(userId) {
  if (dbReady) {
    await db.clearUserSession(userId);
  } else {
    const key = String(userId);
    const saved = userPrefs[key];
    if (saved && typeof saved === 'object') {
      const { phone, contractorProfileId, verifiedAt, withdraw, ...rest } = saved;
      userPrefs[key] = rest;
      saveUserPrefs(userPrefs);
    }
  }
  clearWithdrawState(userId);
}

async function t(userId, key, fallbackLang = 'uz') {
  const lang = (await getLang(userId)) || fallbackLang;
  return i18n[lang][key];
}

async function fetchDriverProfiles() {
  const response = await axios.post(YANDEX_API_URL, {
    query: {
      park: {
        id: PARK_ID
      }
    }
  }, {
    headers: {
      'X-Client-ID': CLIENT_ID,
      'X-Api-Key': process.env.YANDEX_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  return response.data.driver_profiles || [];
}

async function sendMyCards(chatId, userId) {
  if (!dbReady) {
    const def = await getDefaultCard(userId);
    if (!def) return bot.sendMessage(chatId, await t(userId, 'noCards'));
    const lang = (await getLang(userId)) || 'uz';
    return bot.sendMessage(chatId, i18n[lang].chooseSavedCard(maskCardNumber(def.card_number), def.card_name));
  }

  const cards = await db.listUserCards(userId);
  if (!cards || cards.length === 0) {
    return bot.sendMessage(chatId, await t(userId, 'noCards'), {
      reply_markup: {
        inline_keyboard: [[{ text: await t(userId, 'addNewCardBtn'), callback_data: 'user:cards:add' }]],
      },
    });
  }

  const rows = cards.map((c) => {
    const star = c.is_default ? '⭐ ' : '';
    const label = `${star}${maskCardNumber(c.card_number)} — ${String(c.card_name || '').slice(0, 20)}`.trim();
    return [
      { text: label.slice(0, 60), callback_data: `user:cards:set_default:${c.id}` },
    ];
  });
  rows.push([{ text: await t(userId, 'addNewCardBtn'), callback_data: 'user:cards:add' }]);

  return bot.sendMessage(chatId, await t(userId, 'cardsTitle'), {
    reply_markup: { inline_keyboard: rows },
  });
}

function findDriverByPhone(driverProfiles, formattedPhone) {
  for (const driver of driverProfiles) {
    const phones = driver.driver_profile?.phones || [];
    if (phones.includes(formattedPhone)) {
      return driver;
    }
  }
  return null;
}

function newToken() {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 24);
  }
}

function normalizeCardNumber(text) {
  return String(text || '').replace(/\D/g, '');
}

function formatCardNumber(digits) {
  const clean = String(digits || '').replace(/\D/g, '');
  return clean.replace(/(.{4})/g, '$1 ').trim();
}

// YANGI HOLATI (Hamma raqamni to'liq ko'rsatadigan)
function maskCardNumber(digits) {
  return formatCardNumber(digits);
}

function parseAmount(text) {
  const digits = String(text || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  return Number(digits);
}

function phoneToDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function digitsToPhone(digits) {
  const d = phoneToDigits(digits);
  if (!d) return null;
  return d.startsWith('998') ? `+${d}` : `+${d}`;
}

function formatAdminDate(value, locale = 'uz-UZ') {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value || '');
  // Asia/Tashkent
  return d.toLocaleString(locale, { timeZone: 'Asia/Tashkent' });
}

function formatAdminDateLong(value, locale = 'uz-UZ') {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value || '');
  const datePart = d.toLocaleDateString(locale, {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString(locale, {
    timeZone: 'Asia/Tashkent',
    hour: '2-digit',
    minute: '2-digit',
  });
  // e.g. "12-may 2026" / "12 мая 2026 г." + "15:08"
  return `${datePart}, ${timePart}`;
}

function formatAdminSum(value, { currency = '' } = {}) {
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num)) return String(value ?? '');
  const cur = String(currency || '').toUpperCase();
  const noDecimals = cur === 'UZS' || cur === "SO'M" || cur === 'SOM';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: noDecimals ? 0 : 2,
    maximumFractionDigits: noDecimals ? 0 : 2,
  });
}

async function formatStatusLabel(adminId, status) {
  const lang = (await getLang(adminId)) || 'uz';
  const key = `status_${String(status || '').toLowerCase()}`;
  return i18n[lang]?.[key] || String(status || '');
}

async function getBalanceByPhone(userId, formattedPhone) {
  const lang = (await getLang(userId)) || 'uz';
  const driverProfiles = await fetchDriverProfiles();
  const foundDriver = findDriverByPhone(driverProfiles, formattedPhone);
  if (!foundDriver) return null;

  const accounts = foundDriver.accounts || [];
  const balance = accounts[0]?.balance || 'Noma\'lum';
  const currency = accounts[0]?.currency || '';
  const formattedBalance = balance !== 'Noma\'lum'
    ? parseFloat(balance).toLocaleString(i18n[lang].locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : 'Noma\'lum';

  const balanceNumber = balance !== 'Noma\'lum' ? parseFloat(balance) : null;
  return { balanceNumber, formattedBalance, currency };
}

async function startWithdraw(chatId, userId) {
  if (!(await requireValidSession(chatId, userId))) return;
  const phone = await getPhone(userId);
  if (!phone) {
    return bot.sendMessage(chatId, await t(userId, 'noPhoneSaved'));
  }

  const savedCard = await getDefaultCard(userId);
  if (savedCard && typeof savedCard.card_number === 'string' && typeof savedCard.card_name === 'string') {
    setWithdrawState(userId, {
      step: 'choose_saved',
      cardNumber: normalizeCardNumber(savedCard.card_number),
      cardName: savedCard.card_name,
    });

    const lang = (await getLang(userId)) || 'uz';
    return bot.sendMessage(
      chatId,
      i18n[lang].chooseSavedCard(maskCardNumber(savedCard.card_number), savedCard.card_name),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: await t(userId, 'useSavedCardBtn'), callback_data: 'user:withdraw:use_saved' },
              { text: await t(userId, 'otherCardBtn'), callback_data: 'user:withdraw:other_card' },
            ],
          ],
        },
      }
    );
  }

  setWithdrawState(userId, { step: 'card' });
  return bot.sendMessage(chatId, await t(userId, 'enterCardNumber'));
}

// API so'rovini va haydovchi ma'lumotlarini qayta ishlash funksiyasi
async function searchAndDisplayDriver(chatId, userId, formattedPhone) {
  try {
    const lang = (await getLang(userId)) || 'uz';
    const driverProfiles = await fetchDriverProfiles();
    const foundDriver = findDriverByPhone(driverProfiles, formattedPhone);

    if (foundDriver) {
      // Haydovchi topildi: ma'lumotlarni yuborish
      console.log('=== HAYDOVCHI BARCHA MA\'LUMOTLARI ===');
      console.log(JSON.stringify(foundDriver, null, 2));
      console.log('===================================');
      
      const profile = foundDriver.driver_profile;
      const accounts = foundDriver.accounts || [];
      const car = foundDriver.car || {};

      const balance = accounts[0]?.balance || 'Noma\'lum';
      const currency = accounts[0]?.currency || '';
      
      // Balansni formatlab qo'yish
      const formattedBalance = balance !== 'Noma\'lum' 
        ? parseFloat(balance).toLocaleString(i18n[lang].locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : 'Noma\'lum';

      const driverLicense = profile.driver_license?.normalized_number || 'Noma\'lum';
      const callsign = car.callsign || 'Noma\'lum';
      
      const message = i18n[lang].profileMessage({
        firstName: profile.first_name,
        lastName: profile.last_name,
        formattedPhone,
        formattedBalance,
        currency,
        brand: car.brand,
        model: car.model,
        number: car.number,
        callsign: callsign,
        driverLicense: driverLicense,
      });

      const actionOpts = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: await t(userId, 'withdrawBtn'), callback_data: 'action:withdraw' },
            ],
          ],
        },
      };

      await setPhone(userId, formattedPhone);
      const contractorProfileId =
        foundDriver.contractor_profile_id ||
        foundDriver.contractorProfileId ||
        profile?.contractor_profile_id ||
        profile?.contractorProfileId ||
        profile?.id ||
        null;
      await setContractorProfileId(userId, contractorProfileId ? String(contractorProfileId) : null);
      await setVerifiedNow(userId);
      bot.sendMessage(chatId, message, actionOpts);

      // Console ga chat_id va driver_id ni chiqarish
      console.log(`Chat ID: ${chatId}, Driver ID: ${profile.id}`);
    } else {
      // Haydovchi topilmadi
      bot.sendMessage(chatId, await t(userId, 'notFound'));
    }

  } catch (error) {
    console.error('Xatolik yuz berdi:', error);
    bot.sendMessage(chatId, await t(userId, 'genericError'));
  }
}

async function showBalanceOnly(chatId, userId) {
  if (!(await requireValidSession(chatId, userId))) return;
  const formattedPhone = await getPhone(userId);
  if (!formattedPhone) {
    return bot.sendMessage(chatId, await t(userId, 'noPhoneSaved'));
  }

  try {
    const lang = (await getLang(userId)) || 'uz';
    const driverProfiles = await fetchDriverProfiles();
    const foundDriver = findDriverByPhone(driverProfiles, formattedPhone);
    if (!foundDriver) {
      return bot.sendMessage(chatId, await t(userId, 'notFound'));
    }

    const accounts = foundDriver.accounts || [];
    const balance = accounts[0]?.balance || 'Noma\'lum';
    const currency = accounts[0]?.currency || '';
    const formattedBalance = balance !== 'Noma\'lum'
      ? parseFloat(balance).toLocaleString(i18n[lang].locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
      : 'Noma\'lum';

    return bot.sendMessage(chatId, i18n[lang].balanceOnly({ formattedBalance, currency }));
  } catch (error) {
    console.error('Xatolik yuz berdi:', error);
    return bot.sendMessage(chatId, await t(userId, 'genericError'));
  }
}

async function sendWelcome(chatId, userId) {
  const isAdmin = ADMIN_USER_IDS.has(userId);
  const opts = {
    reply_markup: {
      keyboard: [
        ...(isAdmin
          ? [[{ text: await t(userId, 'adminPanelBtn') }]]
          : [
              [{ text: await t(userId, 'sendPhone'), request_contact: true }],
              [{ text: await t(userId, 'myBalanceBtn') }, { text: await t(userId, 'withdrawBtn') }],
              [{ text: await t(userId, 'myCardsBtn') }],
              [{ text: await t(userId, 'logoutBtn') }],
            ]),
      ],
      one_time_keyboard: true,
      resize_keyboard: true,
    },
  };
  bot.sendMessage(chatId, await t(userId, 'welcome'), opts);
}

async function sendAdminMenu(chatId, adminId) {
  if (!ADMIN_USER_IDS.has(adminId)) return;
  if (!dbReady) return bot.sendMessage(chatId, await t(adminId, 'adminDbRequired'));
  const opts = {
    reply_markup: {
      keyboard: [[{ text: await t(adminId, 'adminPanelBtn') }]],
      resize_keyboard: true,
    },
  };
  const inline = {
    reply_markup: {
      inline_keyboard: [[{ text: await t(adminId, 'adminDriversBtn'), callback_data: 'admin:drivers:page:0' }]],
    },
  };
  await bot.sendMessage(chatId, await t(adminId, 'adminPanelTitle'), opts);
  await bot.sendMessage(chatId, await t(adminId, 'adminDriversBtn'), inline);
}

function sendLanguagePicker(chatId, userId) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `🇺🇿 ${i18n.uz.langName}`, callback_data: 'lang:uz' },
          { text: `🇷🇺 ${i18n.ru.langName}`, callback_data: 'lang:ru' },
          { text: `🇬🇧 ${i18n.en.langName}`, callback_data: 'lang:en' },
        ],
      ],
    },
  };
  getLang(userId)
    .then((lang) => {
      bot.sendMessage(chatId, i18n[lang || 'uz'].chooseLang, opts);
    })
    .catch(() => {
      bot.sendMessage(chatId, i18n.uz.chooseLang, opts);
    });
}

// /start kommandasi: avval til tanlash
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from?.first_name || '';
  const lastName = msg.from?.last_name || '';
  const username = msg.from?.username ? `@${msg.from.username}` : '';
  console.log(
    `[START] chatId=${chatId} userId=${userId} firstName="${firstName}" lastName="${lastName}" username=${username}`
  );
  getLang(userId).then((lang) => {
    if (!lang) return sendLanguagePicker(chatId, userId);
    if (ADMIN_USER_IDS.has(userId)) return sendAdminMenu(chatId, userId);
    return sendWelcome(chatId, userId);
  });
});

// Tilni qayta tanlash uchun
bot.onText(/\/lang/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  sendLanguagePicker(chatId, userId);
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await clearSession(userId);
  await bot.sendMessage(chatId, await t(userId, 'loggedOut'));
  await sendWelcome(chatId, userId);
});

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!ADMIN_USER_IDS.has(userId)) return;
  if (!dbReady) return bot.sendMessage(chatId, await t(userId, 'adminDbRequired'));

  const opts = {
    reply_markup: {
      inline_keyboard: [[{ text: await t(userId, 'adminDriversBtn'), callback_data: 'admin:drivers:page:0' }]],
    },
  };
  await bot.sendMessage(chatId, await t(userId, 'adminPanelTitle'), opts);
});

bot.onText(/\/id/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await bot.sendMessage(chatId, `Telegram user_id: ${userId}`);
});

async function sendAdminDriversPage(chatId, adminId, page) {
  const pageSize = 10;
  const p = Math.max(0, Number(page) || 0);

  const drivers = await fetchDriverProfiles();
  const total = drivers.length;
  const start = p * pageSize;
  const items = drivers.slice(start, start + pageSize);

  const rows = items
    .map((d) => {
      const profile = d.driver_profile || {};
      const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || '—';
      const phones = profile.phones || [];
      const phone = phones[0] || '';
      const digits = phoneToDigits(phone);
      const label = phone ? `${name} (${phone})` : name;
      const cb = digits ? `admin:driver:${digits}:view` : null;
      if (!cb) return null;
      return [{ text: label.slice(0, 60), callback_data: cb }];
    })
    .filter(Boolean);

  const nav = [];
  if (start > 0) nav.push({ text: '⬅️', callback_data: `admin:drivers:page:${p - 1}` });
  nav.push({ text: `${p + 1}/${Math.max(1, Math.ceil(total / pageSize))}`, callback_data: 'noop' });
  if (start + pageSize < total) nav.push({ text: '➡️', callback_data: `admin:drivers:page:${p + 1}` });
  if (nav.length > 0) rows.push(nav);

  await bot.sendMessage(chatId, `👥 Hodimlar: ${total}\nSahifa: ${p + 1}`, {
    reply_markup: { inline_keyboard: rows.length ? rows : [[{ text: await t(adminId, 'adminBackBtn'), callback_data: 'admin:menu' }]] },
  });
}

async function sendAdminDriverView(chatId, adminId, phoneDigits) {
  const phone = digitsToPhone(phoneDigits);
  if (!phone) return;

  const adminLang = (await getLang(adminId)) || 'uz';
  const adminLocale = i18n[adminLang]?.locale || 'uz-UZ';

  const drivers = await fetchDriverProfiles();
  const driver = findDriverByPhone(drivers, phone);
  if (!driver) {
    return bot.sendMessage(chatId, `Haydovchi topilmadi: ${phone}`);
  }
  const profile = driver.driver_profile || {};
  const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || '—';
  const car = driver.car || {};
  const carText = car.brand || car.model || car.number ? `${car.brand || ''} ${car.model || ''}`.trim() + (car.number ? ` (${car.number})` : '') : '—';
  const accounts = driver.accounts || [];
  const balance = accounts[0]?.balance || '—';
  const currency = accounts[0]?.currency || '';

  const msg =
    `👤 Haydovchi: ${name}\n` +
    `📱 Telefon: ${phone}\n` +
    `🚗 Avto: ${carText}\n` +
    `💰 Balans: ${formatAdminSum(balance, { currency })} ${currency}`.trim();

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: await t(adminId, 'adminHistoryBtn'), callback_data: `admin:driver:${phoneDigits}:history:page:0` }],
        [{ text: await t(adminId, 'adminBackBtn'), callback_data: 'admin:drivers:page:0' }],
      ],
    },
  };
  await bot.sendMessage(chatId, msg, opts);
}

async function sendAdminDriverHistory(chatId, adminId, phoneDigits, page) {
  const phone = digitsToPhone(phoneDigits);
  if (!phone) return;
  if (!dbReady) return bot.sendMessage(chatId, await t(adminId, 'adminDbRequired'));

  const adminLang = (await getLang(adminId)) || 'uz';
  const adminLocale = i18n[adminLang]?.locale || 'uz-UZ';
  const statuses = ['completed', 'rejected'];

  const pageSize = 5;
  const p = Math.max(0, Number(page) || 0);
  const total = await db.countWithdrawalsByPhone(phone, { statuses });
  const rows = await db.listWithdrawalsByPhone(phone, { limit: pageSize, offset: p * pageSize, statuses });

  if (!rows || rows.length === 0) {
    return bot.sendMessage(chatId, await t(adminId, 'adminNoHistory'), {
      reply_markup: {
        inline_keyboard: [[{ text: await t(adminId, 'adminBackBtn'), callback_data: `admin:driver:${phoneDigits}:view` }]],
      },
    });
  }

  await bot.sendMessage(chatId, `📜 Tranzaksiyalar tarixi: ${phone}\nSahifa: ${p + 1}/${Math.max(1, Math.ceil(total / pageSize))}`);
  for (const r of rows) {
    const statusLabel = await formatStatusLabel(adminId, r.status);
    const approvedAt = r.approved_at || null;
    const line =
      `💸 Summa: ${formatAdminSum(r.amount, { currency: r.currency })} ${r.currency || ''}\n` +
      `📌 Holat: ${statusLabel}\n` +
      `🕒 So‘rov vaqti: ${formatAdminDateLong(r.created_at, adminLocale)}\n` +
      (r.status === 'completed' && approvedAt
        ? `✅ Admin tasdiqlagan: ${formatAdminDateLong(approvedAt, adminLocale)}\n`
        : '') +
      (r.status === 'rejected'
        ? `❌ Admin rad etgan: ${formatAdminDateLong(r.updated_at || r.created_at, adminLocale)}\n`
        : '') +
      (r.reject_reason ? `❌ Sabab: ${r.reject_reason}\n` : '');
    if (r.receipt_file_id) {
      try {
        await bot.sendPhoto(chatId, r.receipt_file_id, { caption: line.slice(0, 1024) });
      } catch {
        await bot.sendMessage(chatId, line);
      }
    } else {
      await bot.sendMessage(chatId, line);
    }
  }

  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: `admin:driver:${phoneDigits}:history:page:${p - 1}` });
  nav.push({ text: `${p + 1}/${Math.max(1, Math.ceil(total / pageSize))}`, callback_data: 'noop' });
  if ((p + 1) * pageSize < total) nav.push({ text: '➡️', callback_data: `admin:driver:${phoneDigits}:history:page:${p + 1}` });

  await bot.sendMessage(chatId, '—', {
    reply_markup: {
      inline_keyboard: [
        nav,
        [{ text: await t(adminId, 'adminBackBtn'), callback_data: `admin:driver:${phoneDigits}:view` }],
      ].filter((r) => r && r.length > 0),
    },
  });
}

bot.on('callback_query', async (query) => {
  try {
    // Ack fast to stop Telegram spinner.
    try { await bot.answerCallbackQuery(query.id); } catch {}

    const chatId = query.message?.chat?.id;
    const userId = query.from.id;
    const data = query.data || '';

    if (!chatId) return;
    console.log(`[CB] chatId=${chatId} userId=${userId} data="${data}"`);

    if (data.startsWith('lang:')) {
      const lang = data.split(':')[1];
      if (lang === 'uz' || lang === 'ru' || lang === 'en') {
        await setLang(userId, lang);
        try {
          if (query.message?.message_id) {
            await bot.editMessageReplyMarkup(
              { inline_keyboard: [] },
              { chat_id: chatId, message_id: query.message.message_id }
            );
          }
        } catch {}
        if (ADMIN_USER_IDS.has(userId)) {
          await sendAdminMenu(chatId, userId);
        } else {
          await sendWelcome(chatId, userId);
        }
        return;
      }
    }

    if (data.startsWith('user:withdraw:')) {
      if (data === 'user:withdraw:use_saved') {
        const st = getWithdrawState(userId);
        if (st && st.step === 'choose_saved' && st.cardNumber && st.cardName) {
          setWithdrawState(userId, { step: 'amount', cardNumber: st.cardNumber, cardName: st.cardName });
          await bot.sendMessage(chatId, await t(userId, 'enterWithdrawAmount'));
        }
        return;
      }
      if (data === 'user:withdraw:other_card') {
        setWithdrawState(userId, { step: 'card' });
        await bot.sendMessage(chatId, await t(userId, 'enterCardNumber'));
        return;
      }
    }

    if (data.startsWith('user:cards:')) {
      if (data === 'user:cards:add') {
        setCardFlowState(userId, { step: 'card' });
        await bot.sendMessage(chatId, await t(userId, 'enterCardNumber'));
        return;
      }
      if (data.startsWith('user:cards:set_default:')) {
        if (!dbReady) return;
        const id = Number(data.split(':')[3]);
        if (!Number.isFinite(id)) return;
        await db.setDefaultCardById(userId, id);
        await bot.sendMessage(chatId, await t(userId, 'cardSaved'));
        await sendMyCards(chatId, userId);
        return;
      }
    }

    if (data === 'noop') return;

    if (data === 'admin:menu') {
      if (!ADMIN_USER_IDS.has(userId)) return;
      const opts = {
        reply_markup: {
          inline_keyboard: [[{ text: await t(userId, 'adminDriversBtn'), callback_data: 'admin:drivers:page:0' }]],
        },
      };
      await bot.sendMessage(chatId, await t(userId, 'adminPanelTitle'), opts);
      return;
    }

    if (data.startsWith('admin:drivers:page:')) {
      if (!ADMIN_USER_IDS.has(userId)) return;
      const p = Number(data.split(':')[3] || 0);
      await sendAdminDriversPage(chatId, userId, p);
      return;
    }

    if (data.startsWith('admin:driver:') && data.endsWith(':view')) {
      if (!ADMIN_USER_IDS.has(userId)) return;
      const phoneDigits = data.split(':')[2];
      await sendAdminDriverView(chatId, userId, phoneDigits);
      return;
    }

    if (data.startsWith('admin:driver:') && data.includes(':history:page:')) {
      if (!ADMIN_USER_IDS.has(userId)) return;
      const parts = data.split(':');
      const phoneDigits = parts[2];
      const p = Number(parts[5] || 0);
      await sendAdminDriverHistory(chatId, userId, phoneDigits, p);
      return;
    }

    if (data === 'action:withdraw') {
      await startWithdraw(chatId, userId);
      return;
    }

    if (data.startsWith('admin:withdraw:')) {
      const token = data.split(':')[2];
      const action = data.split(':')[3]; // approve|reject

      if (!ADMIN_USER_IDS.has(userId)) return;

      const req = dbReady ? await db.getWithdrawal(token) : pendingWithdrawals.get(token);
      if (!req) {
        try { await bot.answerCallbackQuery(query.id, { text: 'Not found', show_alert: true }); } catch {}
        return;
      }

      if (action === 'approve') {
        const targetUserId = Number(req.user_id ?? req.userId);
        if (dbReady) {
          await db.updateWithdrawal(token, { status: 'await_receipt', approved_by: userId, approved_at: new Date() });
        } else {
          pendingWithdrawals.set(token, { ...req, status: 'await_receipt', approvedBy: userId });
        }
        adminStates.set(userId, { step: 'await_receipt', token });

        bot.sendMessage(targetUserId, await t(targetUserId, 'withdrawApproved'));
        bot.sendMessage(chatId, await t(userId, 'adminAskReceipt'));
        return;
      }
      if (action === 'reject') {
        if (dbReady) {
          await db.updateWithdrawal(token, { status: 'await_reject_reason' });
        } else {
          pendingWithdrawals.set(token, { ...req, status: 'await_reject_reason' });
        }
        adminStates.set(userId, { step: 'reject_reason', token });

        bot.sendMessage(chatId, await t(userId, 'adminAskRejectReason'));
        return;
      }
    }
  } catch (e) {
    console.error('callback_query error:', e?.stack || e?.message || e);
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;
    if (chatId && userId) {
      try { await bot.sendMessage(chatId, await t(userId, 'genericError')); } catch {}
    }
  }
});

async function adminFinishReject(adminId, token, reason) {
  const req = dbReady ? await db.getWithdrawal(token) : pendingWithdrawals.get(token);
  if (!req) {
    return bot.sendMessage(adminId, await t(adminId, 'adminNotFound'));
  }
  if (dbReady) {
    await db.updateWithdrawal(token, { status: 'rejected', reject_reason: reason ? String(reason).trim() : null });
  } else {
    pendingWithdrawals.delete(token);
  }
  adminStates.delete(adminId);

  const targetUserId = Number(req.user_id ?? req.userId);
  if (reason && String(reason).trim().length > 0) {
    const userLang = (await getLang(targetUserId)) || 'uz';
    await bot.sendMessage(targetUserId, i18n[userLang].withdrawRejectedWithReason(String(reason).trim()));
  } else {
    await bot.sendMessage(targetUserId, await t(targetUserId, 'withdrawRejected'));
  }
  await bot.sendMessage(adminId, await t(adminId, 'adminDone'));
}

async function adminFinishWithReceipt(adminId, token, fileId) {
  const req = dbReady ? await db.getWithdrawal(token) : pendingWithdrawals.get(token);
  if (!req) {
    return bot.sendMessage(adminId, await t(adminId, 'adminNotFound'));
  }
  const approvedBy = req.approved_by ?? req.approvedBy;
  if (approvedBy && Number(approvedBy) !== adminId) {
    return bot.sendMessage(adminId, await t(adminId, 'adminNotFound'));
  }

  const targetUserId = Number(req.user_id ?? req.userId);
  const contractorProfileId = await getContractorProfileId(targetUserId);
  if (!contractorProfileId) {
    if (dbReady) {
      await db.updateWithdrawal(token, { status: 'txn_failed', receipt_file_id: fileId || null });
    }
    adminStates.delete(adminId);
    await bot.sendMessage(adminId, await t(adminId, 'adminTxnFailed'));
    await bot.sendMessage(targetUserId, await t(targetUserId, 'userTxnFailed'));
    return;
  }

  try {
    const amountNum = Number(req.amount);
    const res = await yandexFleet.createDriverProfileTransaction({
      amount: -amountNum,
      contractorProfileId,
      parkId: PARK_ID,
      description: `Bot payout ${token}`,
      kind: 'payout',
      idempotencyToken: token,
    });

    if (res && res.disabled) {
      adminStates.delete(adminId);
      await bot.sendMessage(adminId, await t(adminId, 'adminTxnDisabled'));
      return;
    }
  } catch (e) {
    console.error('Yandex payout error:', e?.response?.data || e?.message || e);
    if (dbReady) {
      await db.updateWithdrawal(token, { status: 'txn_failed', receipt_file_id: fileId || null });
    }
    adminStates.delete(adminId);
    await bot.sendMessage(adminId, await t(adminId, 'adminTxnFailed'));
    await bot.sendMessage(targetUserId, await t(targetUserId, 'userTxnFailed'));
    return;
  }

  if (dbReady) {
    await db.updateWithdrawal(token, { status: 'completed', receipt_file_id: fileId || null });
  } else {
    pendingWithdrawals.delete(token);
  }
  adminStates.delete(adminId);

  if (fileId) {
    await bot.sendPhoto(targetUserId, fileId, { caption: await t(targetUserId, 'withdrawReceiptCaption') });
  } else {
    await bot.sendMessage(targetUserId, await t(targetUserId, 'withdrawReceiptCaption'));
  }
  await bot.sendMessage(adminId, await t(adminId, 'adminDone'));
}

// Admin chek rasmini yuborganda ushlash
bot.on('message', async (msg) => {
  const userId = msg.from?.id;
  if (!userId || !ADMIN_USER_IDS.has(userId)) return;

  const adminState = adminStates.get(userId);
  if (!adminState || adminState.step !== 'await_receipt') return;

  if (!msg.photo || msg.photo.length === 0) return;
  const best = msg.photo[msg.photo.length - 1];
  if (!best || !best.file_id) return;

  await adminFinishWithReceipt(userId, adminState.token, best.file_id);
});

// Kontakt qabul qilish
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const contact = msg.contact;

  if (ADMIN_USER_IDS.has(userId)) {
    return sendAdminMenu(chatId, userId);
  }

  // Faqat o'z kontaktini qabul qilish
  if (contact.user_id !== msg.from.id) {
    return bot.sendMessage(chatId, await t(userId, 'onlyOwnContact'));
  }

  if (!(await getLang(userId))) {
    return bot.sendMessage(chatId, await t(userId, 'needLangFirst'));
  }

  // Telefon raqamini formatlash: faqat raqamlarni qoldirib, oldiga + qo'shish
  let phoneNumber = contact.phone_number.replace(/\D/g, ''); // Faqat raqamlarni qoldirish
  if (!phoneNumber.startsWith('998')) {
    phoneNumber = '998' + phoneNumber; // Agar 998 yo'q bo'lsa, qo'shish
  }
  const formattedPhone = '+' + phoneNumber;

  await searchAndDisplayDriver(chatId, userId, formattedPhone);
});

// Qo'lda kiritilgan raqamni qabul qilish
bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // Admin oqimi (rad sababi / chek rasm)
  if (ADMIN_USER_IDS.has(userId)) {
    if (text === '/start') return;
    const adminState = adminStates.get(userId);
    if (adminState) {
      if (text === '/skip') {
        if (adminState.step === 'reject_reason') {
          return adminFinishReject(userId, adminState.token, null);
        }
        if (adminState.step === 'await_receipt') {
          return adminFinishWithReceipt(userId, adminState.token, null);
        }
      }

      if (adminState.step === 'reject_reason') {
        return adminFinishReject(userId, adminState.token, text);
      }

      if (adminState.step === 'await_receipt') {
        return bot.sendMessage(chatId, await t(userId, 'adminAskReceipt'));
      }
    }
  }

  // /start va boshqa komandalarni qabul qilmash
  if (text.startsWith('/')) {
    return;
  }

  const lang = await getLang(userId);
  if (!lang) {
    return bot.sendMessage(chatId, await t(userId, 'needLangFirst'));
  }

  const myBalanceBtnText = await t(userId, 'myBalanceBtn');
  const withdrawBtnText = await t(userId, 'withdrawBtn');
  const myCardsBtnText = await t(userId, 'myCardsBtn');
  const logoutBtnText = await t(userId, 'logoutBtn');
  const adminPanelBtnText = await t(userId, 'adminPanelBtn');

  if (ADMIN_USER_IDS.has(userId) && text === adminPanelBtnText) {
    if (!dbReady) return bot.sendMessage(chatId, await t(userId, 'adminDbRequired'));
    const opts = {
      reply_markup: {
        inline_keyboard: [[{ text: await t(userId, 'adminDriversBtn'), callback_data: 'admin:drivers:page:0' }]],
      },
    };
    await bot.sendMessage(chatId, await t(userId, 'adminPanelTitle'), opts);
    return;
  }

  if (text === logoutBtnText) {
    await clearSession(userId);
    await bot.sendMessage(chatId, await t(userId, 'loggedOut'));
    await sendWelcome(chatId, userId);
    return;
  }

  if (text === myCardsBtnText) {
    if (!(await requireValidSession(chatId, userId))) return;
    return sendMyCards(chatId, userId);
  }

  const cardFlow = getCardFlowState(userId);
  if (cardFlow && cardFlow.step) {
    if (!(await isSessionValid(userId))) {
      clearCardFlowState(userId);
      return bot.sendMessage(chatId, await t(userId, 'sessionExpired'));
    }
    if (cardFlow.step === 'card') {
      const cardDigits = normalizeCardNumber(text);
      if (cardDigits.length !== 16) {
        return bot.sendMessage(chatId, await t(userId, 'invalidCardNumber'));
      }
      setCardFlowState(userId, { step: 'name', cardNumber: cardDigits });
      return bot.sendMessage(chatId, await t(userId, 'enterCardName'));
    }
    if (cardFlow.step === 'name') {
      const cardName = String(text || '').trim();
      if (cardName.length < 5) {
        return bot.sendMessage(chatId, await t(userId, 'invalidCardName'));
      }
      await setDefaultCard(userId, cardFlow.cardNumber, cardName);
      clearCardFlowState(userId);
      await bot.sendMessage(chatId, await t(userId, 'cardSaved'));
      return sendMyCards(chatId, userId);
    }
  }

  const withdrawState = getWithdrawState(userId);
  if (withdrawState && withdrawState.step) {
    if (!(await isSessionValid(userId))) {
      clearWithdrawState(userId);
      return bot.sendMessage(chatId, await t(userId, 'sessionExpired'));
    }
    if (withdrawState.step === 'choose_saved') {
      // Wait for inline button selection
      return;
    }
    if (withdrawState.step === 'card') {
      const cardDigits = normalizeCardNumber(text);
      if (cardDigits.length !== 16) {
        return bot.sendMessage(chatId, await t(userId, 'invalidCardNumber'));
      }
      setWithdrawState(userId, { step: 'name', cardNumber: cardDigits });
      return bot.sendMessage(chatId, await t(userId, 'enterCardName'));
    }

    if (withdrawState.step === 'name') {
      const cardName = String(text || '').trim();
      if (cardName.length < 5) {
        return bot.sendMessage(chatId, await t(userId, 'invalidCardName'));
      }
      await setDefaultCard(userId, withdrawState.cardNumber, cardName);
      setWithdrawState(userId, { ...withdrawState, step: 'amount', cardName });

      const phone = await getPhone(userId);
      if (!phone) {
        clearWithdrawState(userId);
        return bot.sendMessage(chatId, await t(userId, 'noPhoneSaved'));
      }

      const bal = await getBalanceByPhone(userId, phone);
      if (!bal) {
        clearWithdrawState(userId);
        return bot.sendMessage(chatId, await t(userId, 'notFound'));
      }

      await bot.sendMessage(chatId, await t(userId, 'enterWithdrawAmount'));
      return;
    }

    if (withdrawState.step === 'amount') {
      const amount = parseAmount(text);
      if (!amount || amount <= 0) {
        return bot.sendMessage(chatId, await t(userId, 'invalidAmount'));
      }

      const phone = await getPhone(userId);
      if (!phone) {
        clearWithdrawState(userId);
        return bot.sendMessage(chatId, await t(userId, 'noPhoneSaved'));
      }

      const bal = await getBalanceByPhone(userId, phone);
      if (!bal) {
        clearWithdrawState(userId);
        return bot.sendMessage(chatId, await t(userId, 'notFound'));
      }

      if (typeof bal.balanceNumber === 'number' && amount > bal.balanceNumber) {
        return bot.sendMessage(chatId, i18n[lang].insufficientFunds({ formattedBalance: bal.formattedBalance, currency: bal.currency }));
      }

      const token = newToken();
      const amountFormatted = formatAdminSum(amount, { currency: bal.currency });

      if (dbReady) {
        await db.createWithdrawal(token, {
          userId,
          phone,
          cardNumber: withdrawState.cardNumber,
          cardName: withdrawState.cardName,
          amount,
          currency: bal.currency,
          status: 'pending',
        });
      } else {
        pendingWithdrawals.set(token, {
          userId,
          amount,
          currency: bal.currency,
          cardNumber: withdrawState.cardNumber,
          cardName: withdrawState.cardName,
          balance: bal.balanceNumber,
          createdAt: new Date().toISOString(),
          status: 'pending',
        });
      }

      clearWithdrawState(userId);

      // Admin'ga yuborish
      let driverName = null;
      let driverFirstName = null;
      let driverLastName = null;
      let driverLicense = null;
      let carBrand = null;
      let carModel = null;
      let carNumber = null;
      let contractorProfileId = null;
      let driverId = null;
      try {
        const driverProfiles = await fetchDriverProfiles();
        const foundDriver = findDriverByPhone(driverProfiles, phone);
        const profile = foundDriver?.driver_profile || null;
        const car = foundDriver?.car || null;
        driverName = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : null;
        driverFirstName = profile?.first_name || null;
        driverLastName = profile?.last_name || null;
        driverLicense = profile?.driver_license?.normalized_number || profile?.driver_license?.number || null;
        driverId = car?.callsign ? String(car.callsign) : null;
        contractorProfileId =
          (foundDriver?.contractor_profile_id || foundDriver?.contractorProfileId || profile?.contractor_profile_id || profile?.contractorProfileId || null)
            ? String(foundDriver?.contractor_profile_id || foundDriver?.contractorProfileId || profile?.contractor_profile_id || profile?.contractorProfileId)
            : null;
        if (car) {
          carBrand = car.brand || null;
          carModel = car.model || null;
          carNumber = car.number || null;
        }
      } catch (e) {
        console.error('Driver info fetch failed:', e?.message || e);
      }

      const adminMsg = i18n[lang].adminNewWithdraw({
        driverName,
        driverFirstName,
        driverLastName,
        driverLicense,
        driverId,
        phone,
        carBrand,
        carModel,
        carNumber,
        contractorProfileId,
        cardNumber: formatCardNumber(withdrawState.cardNumber),
        cardName: withdrawState.cardName,
        formattedBalance: bal.formattedBalance,
        currency: bal.currency,
        amountFormatted,
      });

      const adminOpts = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: await t(userId, 'adminApprove'), callback_data: `admin:withdraw:${token}:approve` },
              { text: await t(userId, 'adminReject'), callback_data: `admin:withdraw:${token}:reject` },
            ],
          ],
        },
      };

      for (const adminId of ADMIN_USER_IDS) {
        bot.sendMessage(adminId, adminMsg, adminOpts);
      }

      return bot.sendMessage(chatId, await t(userId, 'withdrawRequestSent'));
    }
  }

  if (text === myBalanceBtnText) {
    if (!(await requireValidSession(chatId, userId))) return;
    return showBalanceOnly(chatId, userId);
  }

  if (text === withdrawBtnText) {
    if (!(await requireValidSession(chatId, userId))) return;
    return startWithdraw(chatId, userId);
  }

  // Raqamni tekshirish (faqat raqamlardan tashkil topgan)
  const onlyNumbers = text.replace(/\D/g, '');
  if (onlyNumbers.length === 0) {
    return; // Agar raqam bo'lmasa, javob bermaymiz
  }

  // Endi qo'lda raqam qabul qilinmaydi (faqat kontakt yuborish orqali)
  return bot.sendMessage(chatId, await t(userId, 'loginRequired'), await getLoginKeyboard(userId));
});

console.log('Bot ishlamoqda...');
