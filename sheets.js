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
//   Bookings  -> columns: Timestamp | Phone Number | Name | Age | Reason | Date | Slot | Token Number | Payment Status | Visit Type
//   Pending   -> columns: Phone Number | Step | Name | Age | Reason | Date | Slot | Lang | Timestamp
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

// Finds the row where `matchColumn` equals `matchValue` (comparing with the
// leading-apostrophe stripped, since phone numbers/dates/IDs are often
// stored as `'PT-000001` to stop Sheets auto-formatting them) and merges
// `fieldsObj` (keyed by exact header name) into it — creating a new row if
// no match exists. Any header not mentioned in fieldsObj is left untouched.
// Returns { isNew, row, header }.
async function upsertByColumn(tabName, matchColumn, matchValue, fieldsObj) {
  const { header, rows } = await readTab(tabName);
  const matchIdx = header.indexOf(matchColumn);
  if (matchIdx === -1) {
    throw new Error(`upsertByColumn: column "${matchColumn}" not found in "${tabName}" tab header row.`);
  }

  const existingIndex = rows.findIndex((r) => stripQuote(r[matchIdx]) === matchValue);
  const isNew = existingIndex === -1;
  const baseRow = isNew ? new Array(header.length).fill('') : [...rows[existingIndex]];
  while (baseRow.length < header.length) baseRow.push('');

  header.forEach((colName, i) => {
    if (Object.prototype.hasOwnProperty.call(fieldsObj, colName)) {
      const val = fieldsObj[colName];
      if (val !== undefined) baseRow[i] = val === null ? '' : val;
    }
  });

  if (isNew) {
    await appendRow(tabName, baseRow);
  } else {
    await updateRow(tabName, existingIndex + 2, baseRow);
  }
  return { isNew, row: rowToObject(header, baseRow), header };
}

// Finds a single row by an exact column match and returns it as an object
// (or null). Used for lookups by ID (Patient ID, Booking ID, Record ID...).
async function findRowByColumn(tabName, matchColumn, matchValue) {
  const { header, rows } = await readTab(tabName);
  const matchIdx = header.indexOf(matchColumn);
  if (matchIdx === -1) return null;
  const row = rows.find((r) => stripQuote(r[matchIdx]) === matchValue);
  return row ? rowToObject(header, row) : null;
}

// Returns every row where `matchColumn` equals `matchValue`, as objects.
// Finds a row matching TWO columns at once (used for Patients, where the
// real identity is (Phone Number, Name) — the same WhatsApp number is
// often shared by a whole family, and each family member must get their
// own separate row/Patient ID, not be merged into one). Case-insensitive,
// trimmed name comparison so "Sourabh" and "sourabh " still match the same
// person. Mirrors upsertByColumn's merge behaviour otherwise.
async function upsertByTwoColumns(tabName, colA, valueA, colB, valueB, fieldsObj) {
  const { header, rows } = await readTab(tabName);
  const idxA = header.indexOf(colA);
  const idxB = header.indexOf(colB);
  if (idxA === -1 || idxB === -1) {
    throw new Error(`upsertByTwoColumns: column "${idxA === -1 ? colA : colB}" not found in "${tabName}" tab header row.`);
  }
  const normB = (valueB || '').trim().toLowerCase();

  const existingIndex = rows.findIndex(
    (r) => stripQuote(r[idxA]) === valueA && (r[idxB] || '').trim().toLowerCase() === normB
  );
  const isNew = existingIndex === -1;
  const baseRow = isNew ? new Array(header.length).fill('') : [...rows[existingIndex]];
  while (baseRow.length < header.length) baseRow.push('');

  header.forEach((colName, i) => {
    if (Object.prototype.hasOwnProperty.call(fieldsObj, colName)) {
      const val = fieldsObj[colName];
      if (val !== undefined) baseRow[i] = val === null ? '' : val;
    }
  });

  if (isNew) {
    await appendRow(tabName, baseRow);
  } else {
    await updateRow(tabName, existingIndex + 2, baseRow);
  }
  return { isNew, row: rowToObject(header, baseRow), header };
}

// Same idea as findRowByColumn, but matching two columns (see
// upsertByTwoColumns above for why Patients needs this).
async function findRowByTwoColumns(tabName, colA, valueA, colB, valueB) {
  const { header, rows } = await readTab(tabName);
  const idxA = header.indexOf(colA);
  const idxB = header.indexOf(colB);
  if (idxA === -1 || idxB === -1) return null;
  const normB = (valueB || '').trim().toLowerCase();
  const row = rows.find((r) => stripQuote(r[idxA]) === valueA && (r[idxB] || '').trim().toLowerCase() === normB);
  return row ? rowToObject(header, row) : null;
}

// Every family member calling from the same WhatsApp number gets found
// here — used to show "which of these patients is this booking for" type
// views. Not used for identity matching (that's phone+name); this is for
// listing.
async function findAllRowsByColumn(tabName, matchColumn, matchValue) {
  const { header, rows } = await readTab(tabName);
  const matchIdx = header.indexOf(matchColumn);
  if (matchIdx === -1) return [];
  return rows.filter((r) => stripQuote(r[matchIdx]) === matchValue).map((r) => rowToObject(header, r));
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
  sheetIdCache = null; // stale now that a new tab exists — refetch next time it's needed
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

// Cache of tab title -> numeric sheetId (grid id), needed for row deletion
// (batchUpdate deleteDimension addresses sheets by grid id, not title).
let sheetIdCache = null;
async function getSheetIdByTitle(tabName) {
  const sheets = await getSheetsClient();
  if (!sheetIdCache) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    sheetIdCache = {};
    (meta.data.sheets || []).forEach((s) => {
      sheetIdCache[s.properties.title] = s.properties.sheetId;
    });
  }
  if (!(tabName in sheetIdCache)) {
    // Tab may have been added after we cached — refresh once.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    sheetIdCache = {};
    (meta.data.sheets || []).forEach((s) => {
      sheetIdCache[s.properties.title] = s.properties.sheetId;
    });
  }
  return sheetIdCache[tabName];
}

// Deletes the row where `matchColumn` equals `matchValue`. Used for real
// deletes (e.g. removing a Files row when a file is deleted) where marking
// a status column isn't appropriate. No-op (returns false) if no match.
async function deleteRowByColumn(tabName, matchColumn, matchValue) {
  const { header, rows } = await readTab(tabName);
  const matchIdx = header.indexOf(matchColumn);
  if (matchIdx === -1) return false;
  const existingIndex = rows.findIndex((r) => stripQuote(r[matchIdx]) === matchValue);
  if (existingIndex === -1) return false;

  const sheetId = await getSheetIdByTitle(tabName);
  const sheetRowNumber = existingIndex + 2; // +1 header, +1 for 1-indexing
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: sheetRowNumber - 1,
              endIndex: sheetRowNumber,
            },
          },
        },
      ],
    },
  });
  return true;
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
    newPatientFee: map['New Patient Fee'] || map['Appointment Fee'] || '0',
    followUpFee: map['Follow-up Fee'] || map['Appointment Fee'] || '0',
    caseValidityDays: map['Case Paper Validity Days'] || '30',
    upiId: map['UPI ID'] || '',
    staffNumber: (map['Staff WhatsApp Number'] || '').replace(/\D/g, ''),
    clinicName: map['Clinic Name'] || 'the clinic',
    clinicAddress: map['Clinic Address'] || '',
    clinicPhone: map['Clinic Phone'] || '',
    doctorName: map['Doctor Name'] || '',
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

// ---------- New vs Follow-up patient detection ----------

// Returns the most recent booking date (YYYY-MM-DD string) for this phone
// number, or null if they've never booked before. Used to decide whether
// someone is a "New" patient (needs a fresh case paper) or "Follow-up"
// (case paper from a recent visit is still valid).
async function getLastVisitDate(phone, name) {
  const { header, rows } = await readTab('Bookings');
  const phoneIdx = header.indexOf('Phone Number');
  const dateIdx = header.indexOf('Date');
  const nameIdx = header.indexOf('Name');
  if (phoneIdx === -1 || dateIdx === -1) return null;
  const normName = (name || '').trim().toLowerCase();

  // Scoped to THIS person (phone + name), not the whole phone number — a
  // family member's first-ever visit must count as "New" even if someone
  // else on the same WhatsApp number visited recently.
  const matches = rows.filter(
    (r) =>
      stripQuote(r[phoneIdx]) === phone &&
      (nameIdx === -1 || !name || (r[nameIdx] || '').trim().toLowerCase() === normName)
  );
  if (matches.length === 0) return null;

  const dates = matches.map((r) => stripQuote(r[dateIdx])).filter(Boolean).sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

// "New" or "Follow-up", based on Case Paper Validity Days from Settings.
async function getVisitType(phone, name) {
  const lastVisit = await getLastVisitDate(phone, name);
  if (!lastVisit) return 'New';

  const settings = await getSettings();
  const validityDays = parseInt(settings.caseValidityDays, 10) || 30;

  const last = new Date(`${lastVisit}T00:00:00`);
  const today = new Date(`${istDateStringLocal(0)}T00:00:00`);
  if (isNaN(last.getTime())) return 'New'; // malformed date in the sheet — fail safe to "New"

  const daysSince = Math.round((today - last) / (1000 * 60 * 60 * 24));
  return daysSince <= validityDays ? 'Follow-up' : 'New';
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
            (r) => stripQuote(r[bDateIdx]).trim() === dateStr.trim() && stripQuote(r[bSlotIdx]).trim() === slot
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
  if (bDateIdx === -1) return null;

  const bookedInSlot =
    bSlotIdx === -1
      ? 0
      : bookingsTab.rows.filter(
          (r) => stripQuote(r[bDateIdx]).trim() === dateStr.trim() && stripQuote(r[bSlotIdx]).trim() === slot.trim()
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

async function appendBooking({ name, age, reason, date, slot, token, phone, paymentStatus, visitType }) {
  // Column order here MUST match the actual Bookings tab:
  // Timestamp | Phone Number | Name | Age | Reason | Date | Slot | Token Number | Payment Status | Visit Type
  //
  // Date and Slot are written with a leading apostrophe (same trick as
  // phone numbers) to STOP Google Sheets from auto-converting "2026-09-05"
  // into a real Date type (which then displays as a serial number like
  // 46270 and can never text-match what the bot compares against).
  await appendRow('Bookings', [
    new Date().toISOString(),
    `'${phone}`,
    name,
    age,
    reason || '',
    `'${date}`,
    `'${slot}`,
    token,
    paymentStatus || 'Paid',
    visitType || '',
  ]);
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

// Returns every booking on a given date — used by the staff/doctor
// dashboard page so they can browse and open any patient's case paper from
// a PC, any time, not just from the one-off WhatsApp link.
async function getBookingsForDate(dateStr) {
  const { header, rows } = await readTab('Bookings');
  const dateIdx = header.indexOf('Date');
  if (dateIdx === -1) return [];
  const matched = rows.filter((r) => stripQuote(r[dateIdx]).trim() === dateStr.trim());
  return matched.map((r) => rowToObject(header, r));
}

async function getBookingsBetween(fromDate, toDate) {
  const { header, rows } = await readTab('Bookings');
  const dateIdx = header.indexOf('Date');
  if (dateIdx === -1) return [];
  const matched = rows.filter((r) => {
    const d = stripQuote(r[dateIdx]).trim();
    return d >= fromDate && d <= toDate;
  });
  return matched.map((r) => rowToObject(header, r));
}

// Medicine database with default dosage pattern per medicine, from the
// "Medicines" tab. Read by COLUMN POSITION (A, B, C, D, E) rather than
// matching header text exactly — the header row's wording doesn't matter,
// only the order: Medicine Name | Morning | Evening | Before Meal | After Meal.
// Used to power the autocomplete + auto-fill in the case-paper prescription
// table — doctor picks a medicine, the dosage pattern fills itself in, and
// only "Days" is left for manual entry (since duration varies per patient).
async function getMedicineDatabase() {
  try {
    const { rows } = await readTab('Medicines');
    return rows
      .map((r) => ({
        name: (r[0] || '').trim(),
        morning: (r[1] || '').trim(),
        evening: (r[2] || '').trim(),
        beforeMeal: (r[3] || '').trim(),
        afterMeal: (r[4] || '').trim(),
      }))
      .filter((m) => m.name);
  } catch (err) {
    console.error('getMedicineDatabase: could not read "Medicines" tab. Error:', err.message);
    return [];
  }
}

// Looks up a single confirmed booking for the case-paper page — matched by
// phone + date + token (all three together, since a patient could in theory
// book more than once on the same day).
async function findBooking({ phone, date, token }) {
  const { header, rows } = await readTab('Bookings');
  const phoneIdx = header.indexOf('Phone Number');
  const dateIdx = header.indexOf('Date');
  const tokenIdx = header.indexOf('Token Number');
  if (phoneIdx === -1 || dateIdx === -1 || tokenIdx === -1) return null;

  const match = rows.find(
    (r) =>
      stripQuote(r[phoneIdx]) === phone &&
      stripQuote(r[dateIdx]).trim() === date.trim() &&
      String(r[tokenIdx]).trim() === String(token).trim()
  );
  if (!match) return null;

  const obj = rowToObject(header, match);
  // Defensive strip in case any stray leading apostrophes are ever visible
  // in the returned values (shouldn't happen, but keeps the case-paper page
  // clean either way).
  if (obj.Date) obj.Date = stripQuote(obj.Date);
  if (obj.Slot) obj.Slot = stripQuote(obj.Slot);
  return obj;
}

// ---------- Counters tab (Counter Type | Current Value | Updated At) ----------
// Raw read/write only — the increment-with-lock logic and ID formatting
// (PT-000001, APT-2026-000001, etc.) lives in counters.js, which calls
// these two functions. Kept here (not in counters.js) so counters.js has
// no need to know about readTab/appendRow/updateRow internals.

async function getCounterValue(counterType) {
  const { header, rows } = await readTab('Counters');
  const typeIdx = header.indexOf('Counter Type');
  const valueIdx = header.indexOf('Current Value');
  if (typeIdx === -1 || valueIdx === -1) return 0;
  const row = rows.find((r) => (r[typeIdx] || '').trim() === counterType);
  if (!row) return 0;
  return parseInt(row[valueIdx], 10) || 0;
}

async function setCounterValue(counterType, value) {
  await upsertByColumn('Counters', 'Counter Type', counterType, {
    'Counter Type': counterType,
    'Current Value': value,
    'Updated At': new Date().toISOString(),
  });
}

// ---------- Patients tab (extended profile) ----------
// Columns beyond the original Phone Number/Name/Age/Lang/Last Visit Date:
// Patient ID | Date of Birth | Gender | Address | City | Blood Group |
// Allergies | Medical History | Current Medicines | Emergency Contact Name |
// Emergency Contact Relation | Emergency Contact Phone | Profile Token |
// Profile Token Expiry | Profile Completed | Total Visits | Created At |
// Updated At
//
// These functions are ADDITIVE — the original getPatientProfile/
// upsertPatientProfile above are untouched and keep working exactly as
// before for the WhatsApp booking flow. Use these when you need the
// extended fields (patient profile page, dashboard, case paper history).

async function getPatientFullProfile(phone) {
  return findRowByColumn('Patients', 'Phone Number', phone);
}

// Use this (not getPatientFullProfile) whenever the medical/personal info
// of ONE SPECIFIC family member matters (allergies, saved profile fields,
// visit count) — several patients can share one phone number.
async function getPatientProfileByPhoneAndName(phone, name) {
  return findRowByTwoColumns('Patients', 'Phone Number', phone, 'Name', name);
}

async function getPatientByPatientId(patientId) {
  return findRowByColumn('Patients', 'Patient ID', patientId);
}

// Ensures this phone number has a Patient ID, generating one via
// counters.nextPatientId() if it doesn't. Returns the Patient ID.
// Takes the id-generator as a parameter (rather than require()-ing
// counters.js here) to avoid a circular require between sheets.js and
// counters.js, since counters.js itself calls getCounterValue/setCounterValue
// above.
// Ensures THIS SPECIFIC PERSON (phone + name) has a Patient ID — not just
// this phone number. A family sharing one WhatsApp number and booking for
// different members must get a separate Patient ID/file per member, so
// matching is on (Phone Number, Name), not phone alone.
async function ensurePatientId(phone, name, generateId) {
  const existing = await findRowByTwoColumns('Patients', 'Phone Number', phone, 'Name', name);
  if (existing && existing['Patient ID']) return existing['Patient ID'];

  const patientId = await generateId();
  await upsertByTwoColumns('Patients', 'Phone Number', phone, 'Name', name, {
    'Phone Number': `'${phone}`,
    Name: name,
    'Patient ID': patientId,
    'Created At': (existing && existing['Created At']) || new Date().toISOString(),
    'Updated At': new Date().toISOString(),
  });
  return patientId;
}

// Partial update of the extended profile fields — only touches the keys
// present in `fields` (exact header names as documented above). Used by
// the patient self-service profile page and by staff editing from the
// dashboard. Also bumps "Updated At".
async function updatePatientExtendedProfile(phone, name, fields) {
  const payload = { ...fields, 'Updated At': new Date().toISOString() };
  const { row } = await upsertByTwoColumns('Patients', 'Phone Number', phone, 'Name', name, payload);
  return row;
}

async function incrementPatientVisitCount(phone, name, lastVisitDate) {
  const existing = await getPatientProfileByPhoneAndName(phone, name);
  const current = (existing && parseInt(existing['Total Visits'], 10)) || 0;
  await upsertByTwoColumns('Patients', 'Phone Number', phone, 'Name', name, {
    'Total Visits': current + 1,
    'Last Visit Date': lastVisitDate ? `'${lastVisitDate}` : '',
    'Updated At': new Date().toISOString(),
  });
}

// ---------- Secure patient-profile links ----------
// Token itself (long random string) is generated in profile.js using
// crypto.randomBytes — sheets.js only stores/looks it up so the phone
// number and Patient ID never appear in the URL.

async function setProfileToken(phone, name, token, expiryIso) {
  await upsertByTwoColumns('Patients', 'Phone Number', phone, 'Name', name, {
    'Profile Token': token,
    'Profile Token Expiry': expiryIso || '',
  });
}

async function getPatientByProfileToken(token) {
  return findRowByColumn('Patients', 'Profile Token', token);
}

async function searchPatients(query) {
  const { rows } = await readTab('Patients');
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const { header } = await readTab('Patients');
  return rows
    .map((r) => rowToObject(header, r))
    .filter((p) => {
      const name = (p.Name || '').toLowerCase();
      const phone = stripQuote(p['Phone Number'] || '');
      const patientId = (p['Patient ID'] || '').toLowerCase();
      return name.includes(q) || phone.includes(q) || patientId.includes(q.toUpperCase()) || patientId.includes(q);
    });
}

async function getAllPatients() {
  const { header, rows } = await readTab('Patients');
  return rows.map((r) => rowToObject(header, r));
}

// ---------- Bookings tab (extended) ----------
// New columns beyond the original Timestamp..Visit Type:
// Booking ID | Patient ID | Case Paper Number | Booking Status |
// Queue Status | Updated At
//
// appendBookingRow writes by HEADER NAME (unlike the original fixed-array
// appendBooking above, which is left untouched for safety). This is the
// version finalizeBooking() in server.js calls now, so every new booking
// gets its Booking ID / Patient ID / Case Paper Number recorded on the
// same row instead of needing a second write.

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

async function getBookingByBookingId(bookingId) {
  return findRowByColumn('Bookings', 'Booking ID', bookingId);
}

async function updateBookingByBookingId(bookingId, fields) {
  const payload = { ...fields, 'Updated At': new Date().toISOString() };
  const { row } = await upsertByColumn('Bookings', 'Booking ID', bookingId, payload);
  return row;
}

async function getBookingsForPatientId(patientId) {
  return findAllRowsByColumn('Bookings', 'Patient ID', patientId);
}

// ---------- Records tab (diagnosis / doctor notes, linked to a booking) ----------
// Record ID | Patient ID | Booking ID | Case Paper Number | Date |
// Doctor Name | Reason | Diagnosis | Doctor Notes | Prescription ID | Created At

async function appendRecord(fields) {
  const { header } = await readTab('Records');
  const row = new Array(header.length).fill('');
  header.forEach((colName, i) => {
    if (Object.prototype.hasOwnProperty.call(fields, colName)) {
      row[i] = fields[colName] === undefined || fields[colName] === null ? '' : fields[colName];
    }
  });
  await appendRow('Records', row);
}

async function getRecordsForPatient(patientId) {
  return findAllRowsByColumn('Records', 'Patient ID', patientId);
}

async function getRecordByBookingId(bookingId) {
  return findRowByColumn('Records', 'Booking ID', bookingId);
}

// ---------- Files tab (metadata only — actual bytes live in Google Drive) ----------
// File ID | Patient ID | Record ID | File Name | File Type |
// Google Drive File ID | Google Drive URL | Uploaded By | Uploaded At

async function appendFileMeta(fields) {
  const { header } = await readTab('Files');
  const row = new Array(header.length).fill('');
  header.forEach((colName, i) => {
    if (Object.prototype.hasOwnProperty.call(fields, colName)) {
      row[i] = fields[colName] === undefined || fields[colName] === null ? '' : fields[colName];
    }
  });
  await appendRow('Files', row);
}

async function getFilesForPatient(patientId) {
  return findAllRowsByColumn('Files', 'Patient ID', patientId);
}

async function getFileById(fileId) {
  return findRowByColumn('Files', 'File ID', fileId);
}

async function deleteFileMeta(fileId) {
  return deleteRowByColumn('Files', 'File ID', fileId);
}

// ---------- Queue tab (live token queue for a given day) ----------
// Date | Token Number | Booking ID | Patient ID | Status | Checked In At |
// Called At | Started At | Completed At
// Status values: Waiting | Checked-In | Called | In-Consultation | Completed | Skipped | No-Show

async function appendQueueEntry(fields) {
  const { header } = await readTab('Queue');
  const row = new Array(header.length).fill('');
  header.forEach((colName, i) => {
    if (Object.prototype.hasOwnProperty.call(fields, colName)) {
      row[i] = fields[colName] === undefined || fields[colName] === null ? '' : fields[colName];
    }
  });
  await appendRow('Queue', row);
}

async function getQueueForDate(dateStr) {
  const { header, rows } = await readTab('Queue');
  const dateIdx = header.indexOf('Date');
  if (dateIdx === -1) return [];
  return rows
    .filter((r) => stripQuote(r[dateIdx]).trim() === dateStr.trim())
    .map((r) => rowToObject(header, r));
}

async function updateQueueEntryByBookingId(bookingId, fields) {
  const { row } = await upsertByColumn('Queue', 'Booking ID', bookingId, fields);
  return row;
}

module.exports = {
  getSettings,
  setSettingValue,
  getPatientProfile,
  upsertPatientProfile,
  getVisitType,
  getLastVisitDate,
  getBookingsForDate,
  getBookingsBetween,
  getMedicineDatabase,
  findBooking,
  getAvailableSlots,
  getNextAvailableTokenForSlot,
  generateUpcomingSlots,
  appendBooking,
  getPendingState,
  setPendingState,
  clearPendingState,
  findPendingByLastDigits,

  // generic (used by newer modules)
  readTab,
  rowToObject,
  stripQuote,
  colLetter,
  appendRow,
  updateRow,
  upsertByColumn,
  upsertByTwoColumns,
  findRowByColumn,
  findRowByTwoColumns,
  findAllRowsByColumn,
  deleteRowByColumn,

  // schema management (used by schema.js)
  listTabNames,
  createTab,
  ensureHeaderColumns,

  // counters
  getCounterValue,
  setCounterValue,

  // extended patients
  getPatientFullProfile,
  getPatientProfileByPhoneAndName,
  getPatientByPatientId,
  ensurePatientId,
  updatePatientExtendedProfile,
  incrementPatientVisitCount,
  setProfileToken,
  getPatientByProfileToken,
  searchPatients,
  getAllPatients,

  // extended bookings
  appendBookingRow,
  getBookingByBookingId,
  updateBookingByBookingId,
  getBookingsForPatientId,

  // records
  appendRecord,
  getRecordsForPatient,
  getRecordByBookingId,

  // files
  appendFileMeta,
  getFilesForPatient,
  getFileById,
  deleteFileMeta,

  // queue
  appendQueueEntry,
  getQueueForDate,
  updateQueueEntryByBookingId,
};
