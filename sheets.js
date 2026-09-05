// sheets.js
// All persistence lives in one Google Sheet, across four tabs:
//
//   Settings  -> columns: Key | Value             (Appointment Fee, UPI ID, Staff WhatsApp Number, Clinic Name)
//   Capacity  -> columns: Date | Capacity          (Date can be YYYY-MM-DD or the literal "Default")
//   Bookings  -> columns: Timestamp | Name | Age | Date | Token | Phone | Payment Status
//   Pending   -> columns: Phone | Step | Name | Age | Date | UpdatedAt
//
// We deliberately store conversation-in-progress state ("Pending") in the
// Sheet rather than in server memory. Render's free tier spins the service
// down when idle and loses anything held only in RAM — a patient who replies
// a few minutes after the previous message would otherwise get treated as a
// brand new conversation. Writing to the Sheet costs nothing extra since
// we're already authenticated against it, and it survives restarts.

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

let sheetsClientPromise = null;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClientPromise = auth.authorize().then(() => google.sheets({ version: 'v4', auth }));
  }
  return sheetsClientPromise;
}

async function readTab(tabName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:Z`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { header: [], rows: [] };
  const [header, ...body] = rows;
  return { header, rows: body };
}

function rowToObject(header, row) {
  const obj = {};
  header.forEach((key, i) => {
    obj[key] = row[i] !== undefined ? row[i] : '';
  });
  return obj;
}

function stripQuote(phone) {
  return (phone || '').replace(/^'/, '');
}

// ---------- Settings ----------
// Cached briefly so we're not re-reading the Sheet on every single incoming
// message — fee/UPI/staff number rarely change mid-conversation.

let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL_MS = 60 * 1000;

async function getSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;

  const { rows } = await readTab('Settings');
  const map = {};
  rows.forEach((r) => {
    const key = (r[0] || '').trim();
    const value = (r[1] || '').trim();
    if (key) map[key] = value;
  });

  settingsCache = {
    feeAmount: map['Appointment Fee'] || '0',
    upiId: map['UPI ID'] || '',
    staffNumber: (map['Staff WhatsApp Number'] || '').replace(/\D/g, ''),
    clinicName: map['Clinic Name'] || 'the clinic',
  };
  settingsCacheAt = now;
  return settingsCache;
}

// ---------- Capacity ----------

async function getCapacity(dateStr) {
  const { header, rows } = await readTab('Capacity');
  const dateIdx = header.indexOf('Date');
  const capIdx = header.indexOf('Capacity');
  if (dateIdx === -1 || capIdx === -1) return 0;

  const exact = rows.find((r) => r[dateIdx] === dateStr);
  if (exact) return parseInt(exact[capIdx], 10) || 0;

  const fallback = rows.find((r) => r[dateIdx] === 'Default');
  if (fallback) return parseInt(fallback[capIdx], 10) || 0;

  return 0;
}

async function getBookedCount(dateStr) {
  const { header, rows } = await readTab('Bookings');
  const dateIdx = header.indexOf('Date');
  if (dateIdx === -1) return 0;
  return rows.filter((r) => r[dateIdx] === dateStr).length;
}

// Returns the next free token for a date, or null if the day is full.
// NOTE: this only *checks* availability — it does not reserve a slot. We
// call it once when the patient picks a date (just to avoid sending a
// payment QR for a day that's already full), and again right when staff
// confirms payment (to assign the actual token). A slot could in theory be
// taken by someone else in between at clinic scale this is a non-issue —
// only a handful of bookings happen per day.
async function getNextAvailableToken(dateStr) {
  const [capacity, booked] = await Promise.all([
    getCapacity(dateStr),
    getBookedCount(dateStr),
  ]);
  if (booked >= capacity) return null;
  return booked + 1;
}

// ---------- Bookings ----------

async function appendBooking({ name, age, date, token, phone, paymentStatus }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bookings!A:G',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[new Date().toISOString(), name, age, date, token, `'${phone}`, paymentStatus || 'Paid']],
    },
  });
}

// ---------- Pending conversation state ----------

async function getPendingState(phone) {
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone');
  if (phoneIdx === -1) return null;
  const row = rows.find((r) => stripQuote(r[phoneIdx]) === phone);
  if (!row) return null;

  const obj = rowToObject(header, row);
  return {
    phone: stripQuote(obj.Phone),
    step: obj.Step,
    name: obj.Name,
    age: obj.Age,
    date: obj.Date,
    updatedAt: obj.UpdatedAt,
  };
}

// Upserts a row for this phone number. Simple linear scan + update-by-range;
// fine at clinic scale (a handful of concurrent conversations at most).
async function setPendingState(phone, data) {
  const sheets = await getSheetsClient();
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone');

  const newRow = [
    `'${phone}`,
    data.step || '',
    data.name || '',
    data.age || '',
    data.date || '',
    new Date().toISOString(),
  ];

  const existingIndex = phoneIdx === -1 ? -1 : rows.findIndex((r) => stripQuote(r[phoneIdx]) === phone);

  if (existingIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Pending!A:F',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] },
    });
  } else {
    // +2 = +1 for header row, +1 because Sheets ranges are 1-indexed
    const sheetRowNumber = existingIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Pending!A${sheetRowNumber}:F${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [newRow] },
    });
  }
}

async function clearPendingState(phone) {
  // Simplest reliable option with the Sheets API without deleting rows
  // (which would shift every other row's index mid-use): mark it DONE.
  // Any DONE / missing row is treated as "no active conversation".
  await setPendingState(phone, { step: 'DONE', name: '', age: '', date: '' });
}

// Used when staff replies "CONFIRM 9876" — finds the pending row whose
// phone number ends in those last digits and (optionally) is sitting in a
// specific step. Returns null if nothing matches.
async function findPendingByLastDigits(lastDigits, expectedStep) {
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone');
  const stepIdx = header.indexOf('Step');
  if (phoneIdx === -1) return null;

  const match = rows.find((r) => {
    const phone = stripQuote(r[phoneIdx]);
    const stepOk = !expectedStep || r[stepIdx] === expectedStep;
    return stepOk && phone.endsWith(lastDigits);
  });
  if (!match) return null;

  const obj = rowToObject(header, match);
  return {
    phone: stripQuote(obj.Phone),
    step: obj.Step,
    name: obj.Name,
    age: obj.Age,
    date: obj.Date,
  };
}

module.exports = {
  getSettings,
  getCapacity,
  getBookedCount,
  getNextAvailableToken,
  appendBooking,
  getPendingState,
  setPendingState,
  clearPendingState,
  findPendingByLastDigits,
};
