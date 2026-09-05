// sheets.js
// All persistence lives in one Google Sheet, across four tabs:
//
//   Settings  -> columns: Key | Value
//                (rows used: Appointment Fee, UPI ID, Staff WhatsApp Number, Clinic Name)
//   Capacity  -> columns: Date | Slot | Max Capacity | Booked Count
//                (Date can be YYYY-MM-DD or the literal "Default". "Slot" and
//                "Booked Count" are informational only — the bot computes the
//                actual booked count live from the Bookings tab instead of
//                trusting a manually-editable counter.)
//   Bookings  -> columns: Timestamp | Phone Number | Name | Age | Date | Slot | Token Number | Payment Status
//   Pending   -> columns: Phone Number | Step | Name | Age | Date | Slot | Lang | Timestamp
//
// NOTE: header names here must match the Sheet EXACTLY (including spaces) —
// the code looks columns up by header text via indexOf(), not by position.
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

// ---------- Capacity (per date + time slot) ----------

// Returns every slot on a given date that still has room, e.g.
// [{ slot: '10:00 AM', remaining: 2 }, { slot: '10:15 AM', remaining: 1 }]
async function getAvailableSlots(dateStr) {
  const capacityTab = await readTab('Capacity');
  const dateIdx = capacityTab.header.indexOf('Date');
  const slotIdx = capacityTab.header.indexOf('Slot');
  const capIdx = capacityTab.header.indexOf('Max Capacity');
  if (dateIdx === -1 || slotIdx === -1 || capIdx === -1) return [];

  const slotRows = capacityTab.rows.filter((r) => r[dateIdx] === dateStr);
  if (slotRows.length === 0) return [];

  const bookingsTab = await readTab('Bookings');
  const bDateIdx = bookingsTab.header.indexOf('Date');
  const bSlotIdx = bookingsTab.header.indexOf('Slot');

  const results = [];
  for (const row of slotRows) {
    const slot = row[slotIdx];
    const maxCap = parseInt(row[capIdx], 10) || 0;
    const booked =
      bDateIdx === -1 || bSlotIdx === -1
        ? 0
        : bookingsTab.rows.filter((r) => r[bDateIdx] === dateStr && r[bSlotIdx] === slot).length;
    const remaining = maxCap - booked;
    if (remaining > 0) results.push({ slot, remaining });
  }
  return results;
}

// Returns the token number to assign if this exact date+slot still has
// room, or null if it's full. The token itself is a same-day queue number
// (count of ALL bookings that day, not just this slot) so patients get a
// single sequential number for the day regardless of which time they picked.
//
// NOTE: like the old getNextAvailableToken, this only checks at the moment
// it's called — it doesn't reserve a slot in advance. We call it once when
// showing the slot list (to hide full slots) and again right when staff
// confirms payment (to assign the real token). Fine at clinic scale.
async function getNextAvailableTokenForSlot(dateStr, slot) {
  const capacityTab = await readTab('Capacity');
  const dateIdx = capacityTab.header.indexOf('Date');
  const slotIdx = capacityTab.header.indexOf('Slot');
  const capIdx = capacityTab.header.indexOf('Max Capacity');
  if (dateIdx === -1 || slotIdx === -1 || capIdx === -1) return null;

  const capRow = capacityTab.rows.find((r) => r[dateIdx] === dateStr && r[slotIdx] === slot);
  if (!capRow) return null;
  const maxCap = parseInt(capRow[capIdx], 10) || 0;

  const bookingsTab = await readTab('Bookings');
  const bDateIdx = bookingsTab.header.indexOf('Date');
  const bSlotIdx = bookingsTab.header.indexOf('Slot');
  if (bDateIdx === -1) return null;

  const bookedInSlot =
    bSlotIdx === -1 ? 0 : bookingsTab.rows.filter((r) => r[bDateIdx] === dateStr && r[bSlotIdx] === slot).length;
  if (bookedInSlot >= maxCap) return null;

  const bookedInDay = bookingsTab.rows.filter((r) => r[bDateIdx] === dateStr).length;
  return bookedInDay + 1;
}

// ---------- Bookings ----------

async function appendBooking({ name, age, date, slot, token, phone, paymentStatus }) {
  const sheets = await getSheetsClient();
  // Column order here MUST match the actual Bookings tab:
  // Timestamp | Phone Number | Name | Age | Date | Slot | Token Number | Payment Status
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bookings!A:H',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[new Date().toISOString(), `'${phone}`, name, age, date, slot, token, paymentStatus || 'Paid']],
    },
  });
}

// ---------- Pending conversation state ----------

async function getPendingState(phone) {
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone Number');
  if (phoneIdx === -1) return null;
  const row = rows.find((r) => stripQuote(r[phoneIdx]) === phone);
  if (!row) return null;

  const obj = rowToObject(header, row);
  return {
    phone: stripQuote(obj['Phone Number']),
    step: obj.Step,
    name: obj.Name,
    age: obj.Age,
    date: obj.Date,
    slot: obj.Slot,
    lang: obj.Lang,
    updatedAt: obj.Timestamp,
  };
}

// Upserts a row for this phone number. Simple linear scan + update-by-range;
// fine at clinic scale (a handful of concurrent conversations at most).
async function setPendingState(phone, data) {
  const sheets = await getSheetsClient();
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone Number');

  const newRow = [
    `'${phone}`,
    data.step || '',
    data.name || '',
    data.age || '',
    data.date || '',
    data.slot || '',
    data.lang || '',
    new Date().toISOString(),
  ];

  const existingIndex = phoneIdx === -1 ? -1 : rows.findIndex((r) => stripQuote(r[phoneIdx]) === phone);

  if (existingIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Pending!A:H',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] },
    });
  } else {
    // +2 = +1 for header row, +1 because Sheets ranges are 1-indexed
    const sheetRowNumber = existingIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Pending!A${sheetRowNumber}:H${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [newRow] },
    });
  }
}

async function clearPendingState(phone) {
  // Simplest reliable option with the Sheets API without deleting rows
  // (which would shift every other row's index mid-use): mark it DONE.
  // Any DONE / missing row is treated as "no active conversation".
  await setPendingState(phone, { step: 'DONE', name: '', age: '', date: '', slot: '', lang: '' });
}

// Used when staff replies "CONFIRM 9876" — finds the pending row whose
// phone number ends in those last digits and (optionally) is sitting in a
// specific step. Returns null if nothing matches.
async function findPendingByLastDigits(lastDigits, expectedStep) {
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone Number');
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
    phone: stripQuote(obj['Phone Number']),
    step: obj.Step,
    name: obj.Name,
    age: obj.Age,
    date: obj.Date,
    slot: obj.Slot,
    lang: obj.Lang,
  };
}

module.exports = {
  getSettings,
  getAvailableSlots,
  getNextAvailableTokenForSlot,
  appendBooking,
  getPendingState,
  setPendingState,
  clearPendingState,
  findPendingByLastDigits,
};
