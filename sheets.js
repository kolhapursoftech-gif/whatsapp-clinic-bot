// sheets.js
// All persistence lives in one Google Sheet, across three tabs:
//
//   Capacity  -> columns: Date | Capacity        (Date can be YYYY-MM-DD or the literal "Default")
//   Bookings  -> columns: Timestamp | Name | Age | Date | Token | Phone
//   Pending   -> columns: Phone | Step | Name | Age | UpdatedAt
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
async function getNextAvailableToken(dateStr) {
  const [capacity, booked] = await Promise.all([
    getCapacity(dateStr),
    getBookedCount(dateStr),
  ]);
  if (booked >= capacity) return null;
  return booked + 1;
}

// ---------- Bookings ----------

async function appendBooking({ name, age, date, token, phone }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bookings!A:F',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[new Date().toISOString(), name, age, date, token, phone]],
    },
  });
}

// ---------- Pending conversation state ----------

async function getPendingState(phone) {
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone');
  if (phoneIdx === -1) return null;
  const row = rows.find((r) => r[phoneIdx] === phone);
  if (!row) return null;
  return rowToObject(header, row);
}

// Upserts a row for this phone number. Simple linear scan + update-by-range;
// fine at clinic scale (a handful of concurrent conversations at most).
async function setPendingState(phone, data) {
  const sheets = await getSheetsClient();
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone');

  const newRow = [
    phone,
    data.step || '',
    data.name || '',
    data.age || '',
    new Date().toISOString(),
  ];

  const existingIndex = phoneIdx === -1 ? -1 : rows.findIndex((r) => r[phoneIdx] === phone);

  if (existingIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Pending!A:E',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] },
    });
  } else {
    // +2 = +1 for header row, +1 because Sheets ranges are 1-indexed
    const sheetRowNumber = existingIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Pending!A${sheetRowNumber}:E${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [newRow] },
    });
  }
}

async function clearPendingState(phone) {
  // Simplest reliable option with the Sheets API without deleting rows
  // (which would shift every other row's index mid-use): mark it DONE.
  // Any DONE / missing row is treated as "no active conversation".
  await setPendingState(phone, { step: 'DONE', name: '', age: '' });
}

module.exports = {
  getCapacity,
  getBookedCount,
  getNextAvailableToken,
  appendBooking,
  getPendingState,
  setPendingState,
  clearPendingState,
};
