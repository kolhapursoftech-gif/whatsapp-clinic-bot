// sheets.js
// All persistence lives in one Google Sheet. Tabs used:
//
//   Settings  -> Setting Name | Value   (fee, UPI ID, staff number, clinic name, timings...)
//   Capacity  -> Date | Slot | Max Capacity | Booked Count   (slots; auto-generated)
//   Bookings  -> Timestamp | Phone Number | Name | Age | Reason | Date | Slot |
//                Token Number | Payment Status | Fee | Booking Status
//   Pending   -> Phone Number | Step | Name | Age | Reason | Date | Slot | Lang | Timestamp
//                (conversation-in-progress; lives in the Sheet so it survives Render restarts)
//   Patients  -> Phone Number | Name | Age | Lang | Last Visit Date  (remembers returning patients)
//   Today     -> auto formula tab: shows only today's bookings for staff
//
// NOTE: header names must match the Sheet EXACTLY - the code looks columns up
// by header text, not by position.

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
    // A:BZ (not A:Z) — newer tabs like Patients/Records have well over 26
    // columns once the extended profile + medical fields are added.
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:BZ`,
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

// ---------- Generic tab helpers (used by the newer modules: counters,
// patients, records, files, queue) ----------
//
// Older code above writes fixed-position A:E / A:J ranges by hand. Newer
// code below writes by HEADER NAME instead — it reads the tab's header row,
// finds each field's column index, and only touches the columns it was
// given. This makes the new tabs easier to extend (add a column to the
// Sheet, add one field to a fieldsObj — no range strings to update) and
// lets two different features (e.g. the booking flow and the patient
// profile page) update different columns of the same row safely.

// 1-indexed column number -> spreadsheet column letters ("A", "Z", "AA"...).
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Per-tab lock so two near-simultaneous appends to the SAME tab can never
// compute the same "next row" and overwrite each other — see appendRow()
// below for why this is needed instead of the Sheets API's own append.
const appendLocks = new Map();
function withAppendLock(key, fn) {
  const previous = appendLocks.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => { if (appendLocks.get(key) === settled) appendLocks.delete(key); },
    () => { if (appendLocks.get(key) === settled) appendLocks.delete(key); }
  );
  appendLocks.set(key, settled);
  return run;
}

// Appends a row by EXPLICITLY computing the next empty row (current real
// row count + 2) and writing there with values.update — deliberately NOT
// using the Sheets API's own values.append/INSERT_ROWS.
//
// Why: values.append decides where to write based on the sheet's overall
// "used range" (what Ctrl+End jumps to), which can include cells that were
// only ever formatted (borders/column widths/etc, e.g. left over from an
// xlsx import) and never actually held data. When that phantom used-range
// extends far below the real data — we've seen it land 1000+ rows down —
// append() writes new rows way out there instead of right after the real
// data, while every READ (readTab, which only sees actual values) keeps
// reporting the tab as empty. Writes and reads disagreeing like that is
// exactly what caused bookings to "vanish". Computing the row ourselves
// from readTab's own row count keeps writes and reads looking at the same
// reality.
async function appendRow(tabName, values) {
  return withAppendLock(tabName, async () => {
    const { rows } = await readTab(tabName);
    const targetRow = rows.length + 2; // +1 for header, +1 for 1-indexing
    await updateRow(tabName, targetRow, values);
  });
}

// Same idea as appendRow, but for writing several rows in one shot (e.g.
// a week's worth of newly-generated slots) — still lock-guarded and still
// computed from the real row count, not the Sheets API's own append.
async function appendRows(tabName, rowsOfValues) {
  if (!rowsOfValues || rowsOfValues.length === 0) return;
  return withAppendLock(tabName, async () => {
    const { rows } = await readTab(tabName);
    const startRow = rows.length + 2;
    const maxLen = Math.max(...rowsOfValues.map((r) => r.length));
    const endCol = colLetter(maxLen);
    const endRow = startRow + rowsOfValues.length - 1;
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A${startRow}:${endCol}${endRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowsOfValues },
    });
  });
}

async function updateRow(tabName, sheetRowNumber, values) {
  const sheets = await getSheetsClient();
  const endCol = colLetter(values.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A${sheetRowNumber}:${endCol}${sheetRowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

// ---------- Schema management (auto-create tabs/columns) ----------
// Used by schema.js so the app can set up and extend its own Google Sheet
// structure — no more manually adding columns/tabs by hand every time a
// feature needs a new one.

async function listTabNames() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return (meta.data.sheets || []).map((s) => s.properties.title);
}

async function createTab(tabName) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
}

// Reads a tab's current header row (row 1) and writes any headers from
// `requiredHeaders` that aren't already present, immediately to the right
// of the existing ones. Never touches existing headers or any data row.
// Returns { added: [...] } — the headers that were actually written.
//
// IMPORTANT: new columns are anchored to the right-most header we
// RECOGNIZE (i.e. one that's part of `requiredHeaders` and already exists
// in the tab) — not to the tab's raw last-used-column. A tab can have a
// stray "note"/comment cell sitting far to the right of the real headers
// (e.g. an instructional note); anchoring off the physical last-used
// column would push new headers out past that note, leaving a big blank
// gap between the real data columns and the new ones.
async function ensureHeaderColumns(tabName, requiredHeaders) {
  const { header } = await readTab(tabName);
  const missing = requiredHeaders.filter((h) => !header.includes(h));
  if (missing.length === 0) return { added: [] };

  let anchorIndex = -1; // 0-indexed position of the right-most header we recognize
  requiredHeaders.forEach((h) => {
    const idx = header.indexOf(h);
    if (idx > anchorIndex) anchorIndex = idx;
  });
  const startCol = anchorIndex + 2; // +1 to move past it, +1 for 1-indexing
  const endCol = startCol + missing.length - 1;

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!${colLetter(startCol)}1:${colLetter(endCol)}1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [missing] },
  });
  return { added: missing };
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
    // "Appointment Fee" is the one fee now. Falls back to the old
    // "New Patient Fee" so an existing Sheet keeps its fee after upgrade.
    feeAmount: map['Appointment Fee'] || map['New Patient Fee'] || '0',
    upiId: map['UPI ID'] || '',
    staffNumber: (map['Staff WhatsApp Number'] || '').replace(/\D/g, ''),
    alertNumber: (map['Alert WhatsApp Number'] || '').replace(/\D/g, ''),
    clinicName: map['Clinic Name'] || 'the clinic',
    morningStart: map['Morning Start'] || '',
    morningEnd: map['Morning End'] || '',
    eveningStart: map['Evening Start'] || '',
    eveningEnd: map['Evening End'] || '',
    slotDurationMin: map['Slot Duration Minutes'] || '15',
    maxCapacityPerSlot: map['Max Capacity Per Slot'] || '1',
    daysAhead: map['Days To Generate Ahead'] || '7',
    minNoticeMinutes: map['Minimum Notice Minutes'] || '30',
    defaultLanguage: ['mr', 'hi', 'en'].includes((map['Default Language'] || '').trim().toLowerCase())
      ? map['Default Language'].trim().toLowerCase()
      : '',
  };
  settingsCacheAt = now;
  return settingsCache;
}

// Writes (or updates) a single Key/Value row in the Settings tab — used to
// publish computed values back to the sheet, e.g. the dashboard link, so
// the clinic doesn't have to build/copy it by hand. Also clears the local
// cache so the next getSettings() call picks up any change immediately.
async function setSettingValue(key, value) {
  const sheets = await getSheetsClient();
  const { rows } = await readTab('Settings');

  const existingIndex = rows.findIndex((r) => (r[0] || '').trim() === key);
  if (existingIndex === -1) {
    await withAppendLock('Settings', async () => {
      const { rows: freshRows } = await readTab('Settings');
      const targetRow = freshRows.length + 2;
      await updateRow('Settings', targetRow, [key, value]);
    });
  } else {
    const sheetRowNumber = existingIndex + 2; // +1 header, +1 for 1-indexing
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Settings!B${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[value]] },
    });
  }
  settingsCache = null; // force a fresh read next time
}

// ---------- Patients (remembers returning patients across bookings) ----------
// Separate from Pending because Pending gets wiped clean after every single
// booking (step: DONE) — we need something that survives so a patient who
// booked last month doesn't have to pick a language and retype their name
// again this month.

async function getPatientProfile(phone) {
  let header, rows;
  try {
    ({ header, rows } = await readTab('Patients'));
  } catch (err) {
    console.error('getPatientProfile: could not read "Patients" tab — check the tab name exactly. Error:', err.message);
    return null;
  }
  const phoneIdx = header.indexOf('Phone Number');
  if (phoneIdx === -1) {
    console.warn('getPatientProfile: "Phone Number" header not found in Patients tab. Header was:', JSON.stringify(header));
    return null;
  }
  const row = rows.find((r) => stripQuote(r[phoneIdx]) === phone);
  if (!row) return null;

  const obj = rowToObject(header, row);
  return {
    phone: stripQuote(obj['Phone Number']),
    name: obj.Name,
    age: obj.Age,
    lang: obj.Lang,
    lastVisitDate: stripQuote(obj['Last Visit Date']),
  };
}

async function upsertPatientProfile(phone, { name, age, lang, lastVisitDate }) {
  const sheets = await getSheetsClient();
  const { header, rows } = await readTab('Patients');
  const phoneIdx = header.indexOf('Phone Number');
  const nameIdx = header.indexOf('Name');

  const newRow = [`'${phone}`, name || '', age || '', lang || '', lastVisitDate ? `'${lastVisitDate}` : ''];
  const normName = (name || '').trim().toLowerCase();

  // Matched on (Phone Number, Name) — see ensurePatientId's comment above
  // for why phone alone isn't enough (one WhatsApp number, several family
  // members, each their own row).
  const existingIndex =
    phoneIdx === -1 || nameIdx === -1
      ? -1
      : rows.findIndex(
          (r) => stripQuote(r[phoneIdx]) === phone && (r[nameIdx] || '').trim().toLowerCase() === normName
        );

  if (existingIndex === -1) {
    await appendRow('Patients', newRow);
  } else {
    const sheetRowNumber = existingIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Patients!A${sheetRowNumber}:E${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [newRow] },
    });
  }
}

// ---------- Capacity (per date + time slot) ----------

// Returns every slot on a given date that still has room, e.g.
// [{ slot: '10:00 AM', remaining: 2 }, { slot: '10:15 AM', remaining: 1 }]
// If dateStr is today, slots earlier than (now + Minimum Notice Minutes)
// are excluded — otherwise the bot would happily offer a 10:00 AM slot at
// 9:48 PM the same day.
async function getAvailableSlots(dateStr) {
  const capacityTab = await readTab('Capacity');
  const dateIdx = capacityTab.header.indexOf('Date');
  const slotIdx = capacityTab.header.indexOf('Slot');
  const capIdx = capacityTab.header.indexOf('Max Capacity');
  if (dateIdx === -1 || slotIdx === -1 || capIdx === -1) return [];

  const slotRows = capacityTab.rows.filter((r) => stripQuote(r[dateIdx]).trim() === dateStr.trim());
  if (slotRows.length === 0) return [];

  const bookingsTab = await readTab('Bookings');
  const bDateIdx = bookingsTab.header.indexOf('Date');
  const bSlotIdx = bookingsTab.header.indexOf('Slot');
  const bStatusIdx = bookingsTab.header.indexOf('Booking Status');

  const settings = await getSettings();
  const minNotice = parseInt(settings.minNoticeMinutes, 10) || 0;
  const todayStr = istDateStringLocal(0);
  const isToday = dateStr.trim() === todayStr;
  const cutoffMinutes = isToday ? getIstNowMinutes() + minNotice : null;

  const results = [];
  for (const row of slotRows) {
    const slot = stripQuote(row[slotIdx]).trim();

    if (isToday) {
      const slotMinutes = parseTimeToMinutes(slot);
      // If the slot time can't be parsed, don't silently hide it — only
      // exclude slots we can confidently confirm are in the past.
      if (slotMinutes !== null && slotMinutes < cutoffMinutes) continue;
    }

    const maxCap = parseInt(row[capIdx], 10) || 0;
    const booked =
      bDateIdx === -1 || bSlotIdx === -1
        ? 0
        : bookingsTab.rows.filter(
            (r) =>
              stripQuote(r[bDateIdx]).trim() === dateStr.trim() &&
              stripQuote(r[bSlotIdx]).trim() === slot &&
              // A cancelled booking no longer occupies its slot. Staff cancel
              // by typing "Cancelled" in the Booking Status column of the Sheet.
              (bStatusIdx === -1 || r[bStatusIdx] !== 'Cancelled')
          ).length;
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

  const capRow = capacityTab.rows.find(
    (r) => stripQuote(r[dateIdx]).trim() === dateStr.trim() && stripQuote(r[slotIdx]).trim() === slot.trim()
  );
  if (!capRow) return null;
  const maxCap = parseInt(capRow[capIdx], 10) || 0;

  const bookingsTab = await readTab('Bookings');
  const bDateIdx = bookingsTab.header.indexOf('Date');
  const bSlotIdx = bookingsTab.header.indexOf('Slot');
  const bStatusIdx = bookingsTab.header.indexOf('Booking Status');
  if (bDateIdx === -1) return null;

  const bookedInSlot =
    bSlotIdx === -1
      ? 0
      : bookingsTab.rows.filter(
          (r) =>
            stripQuote(r[bDateIdx]).trim() === dateStr.trim() &&
            stripQuote(r[bSlotIdx]).trim() === slot.trim() &&
            (bStatusIdx === -1 || r[bStatusIdx] !== 'Cancelled')
        ).length;
  if (bookedInSlot >= maxCap) return null;

  const bookedInDay = bookingsTab.rows.filter((r) => stripQuote(r[bDateIdx]).trim() === dateStr.trim()).length;
  return bookedInDay + 1;
}

// ---------- Auto-generating Capacity rows from Settings ----------
// Lets the clinic change opening hours / slot length / capacity in one
// place (Settings tab) instead of typing every row by hand. Call
// generateUpcomingSlots() (wired to a protected HTTP endpoint in server.js)
// whenever you want to top up the next few days of slots.

function istDateStringLocal(offsetDays = 0) {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  ist.setDate(ist.getDate() + offsetDays);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, '0');
  const d = String(ist.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Current time-of-day in IST, as minutes since midnight — used to hide
// slots that have already passed (or are too soon) for today's date.
function getIstNowMinutes() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  return ist.getHours() * 60 + ist.getMinutes();
}

// "10:00 AM" / "5:30 PM" -> minutes since midnight. Returns null if the
// text doesn't match (e.g. left blank in Settings — that period is skipped).
function parseTimeToMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((timeStr || '').trim());
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const isPm = /pm/i.test(match[3]);
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function formatMinutesToTime(totalMinutes) {
  let hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const isPm = hour >= 12;
  let hour12 = hour % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${isPm ? 'PM' : 'AM'}`;
}

function buildSlotsForRange(startStr, endStr, durationMin) {
  const start = parseTimeToMinutes(startStr);
  const end = parseTimeToMinutes(endStr);
  if (start === null || end === null || durationMin <= 0) return [];
  const slots = [];
  for (let t = start; t + durationMin <= end; t += durationMin) {
    slots.push(formatMinutesToTime(t));
  }
  return slots;
}

// Generates Date+Slot rows for the next N days (from Settings) and appends
// only the ones that don't already exist in the Capacity tab — safe to run
// again and again (e.g. once a day) without creating duplicates. Changing
// Morning/Evening times or duration in Settings only affects days generated
// AFTER that change; already-generated rows are not retroactively edited.
async function generateUpcomingSlots() {
  const settings = await getSettings();
  const daysAhead = parseInt(settings.daysAhead, 10) || 7;
  const durationMin = parseInt(settings.slotDurationMin, 10) || 15;
  const maxCap = parseInt(settings.maxCapacityPerSlot, 10) || 1;

  const morningSlots = buildSlotsForRange(settings.morningStart, settings.morningEnd, durationMin);
  const eveningSlots = buildSlotsForRange(settings.eveningStart, settings.eveningEnd, durationMin);
  const dailySlots = [...morningSlots, ...eveningSlots];

  if (dailySlots.length === 0) {
    throw new Error(
      'No valid Morning Start/End or Evening Start/End found in Settings (expected format like "10:00 AM").'
    );
  }

  const { header, rows } = await readTab('Capacity');
  const dateIdx = header.indexOf('Date');
  const slotIdx = header.indexOf('Slot');
  const existingKeys = new Set(rows.map((r) => `${stripQuote(r[dateIdx]).trim()}__${stripQuote(r[slotIdx]).trim()}`));

  const newRows = [];
  for (let d = 0; d < daysAhead; d++) {
    const dateStr = istDateStringLocal(d);
    for (const slot of dailySlots) {
      const key = `${dateStr}__${slot}`;
      if (!existingKeys.has(key)) {
        newRows.push([`'${dateStr}`, `'${slot}`, maxCap, 0]);
      }
    }
  }

  if (newRows.length > 0) {
    await appendRows('Capacity', newRows);
  }

  return { daysAhead, slotsPerDay: dailySlots.length, added: newRows.length };
}

// ---------- Bookings ----------

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
    reason: obj.Reason,
    date: stripQuote(obj.Date),
    slot: stripQuote(obj.Slot),
    lang: obj.Lang,
    updatedAt: obj.Timestamp,
  };
}

// Upserts a row for this phone number. Simple linear scan + update-by-range;
// fine at clinic scale (a handful of concurrent conversations at most).
async function setPendingState(phone, data) {
  const { header, rows } = await readTab('Pending');
  const phoneIdx = header.indexOf('Phone Number');

  const newRow = [
    `'${phone}`,
    data.step || '',
    data.name || '',
    data.age || '',
    data.reason || '',
    data.date ? `'${data.date}` : '',
    data.slot ? `'${data.slot}` : '',
    data.lang || '',
    new Date().toISOString(),
  ];

  const existingIndex = phoneIdx === -1 ? -1 : rows.findIndex((r) => stripQuote(r[phoneIdx]) === phone);

  if (existingIndex === -1) {
    await appendRow('Pending', newRow);
  } else {
    // +2 = +1 for header row, +1 because Sheets ranges are 1-indexed
    const sheetRowNumber = existingIndex + 2;
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Pending!A${sheetRowNumber}:I${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [newRow] },
    });
  }
}

async function clearPendingState(phone) {
  // Simplest reliable option with the Sheets API without deleting rows
  // (which would shift every other row's index mid-use): mark it DONE.
  // Any DONE / missing row is treated as "no active conversation".
  await setPendingState(phone, { step: 'DONE', name: '', age: '', reason: '', date: '', slot: '', lang: '' });
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
    reason: obj.Reason,
    date: stripQuote(obj.Date),
    slot: stripQuote(obj.Slot),
    lang: obj.Lang,
  };
}

// Writes a booking row BY HEADER NAME, so it does not matter in which order
// the Bookings columns are. Any field whose column is missing is skipped.
async function appendBookingRow(fields) {
  const { header } = await readTab('Bookings');
  const row = new Array(header.length).fill('');
  header.forEach((colName, i) => {
    if (Object.prototype.hasOwnProperty.call(fields, colName)) {
      row[i] = fields[colName] === undefined || fields[colName] === null ? '' : fields[colName];
    }
  });
  await appendRow('Bookings', row);
}

module.exports = {
  getSettings,
  setSettingValue,
  getPatientProfile,
  upsertPatientProfile,
  getAvailableSlots,
  getNextAvailableTokenForSlot,
  generateUpcomingSlots,
  appendBookingRow,
  getPendingState,
  setPendingState,
  clearPendingState,
  findPendingByLastDigits,

  // generic helpers
  readTab,
  colLetter,
  stripQuote,
  appendRow,
  updateRow,

  // schema management (used by schema.js)
  listTabNames,
  createTab,
  ensureHeaderColumns,
};
