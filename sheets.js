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
const crypto = require('crypto');

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
  console.log(`setSettingValue: writing to spreadsheetId=${SHEET_ID}`);

  const { rows } = await readTab('Settings');

  // Debug: dump every key currently in column A, with char codes, so an
  // invisible/whitespace character mismatch (e.g. from copy-pasting the
  // template) shows up clearly in the logs instead of silently causing a
  // duplicate row to be appended instead of the existing one being updated.
  console.log(
    'setSettingValue: existing keys in Settings!A ->',
    rows.map((r, i) => {
      const raw = r[0] || '';
      return `[row${i + 2}] "${raw.trim()}" (len=${raw.trim().length}, codes=${[...raw.trim()]
        .map((c) => c.charCodeAt(0))
        .join(',')})`;
    })
  );
  console.log(
    `setSettingValue: looking for key "${key}" (len=${key.length}, codes=${[...key]
      .map((c) => c.charCodeAt(0))
      .join(',')})`
  );

  const existingIndex = rows.findIndex((r) => (r[0] || '').trim() === key);

  if (existingIndex === -1) {
    console.log(`setSettingValue: no existing "${key}" row found — appending new row`);
    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Settings!A:B',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[key, value]] },
    });
    console.log('setSettingValue: append response range ->', appendRes.data.updates && appendRes.data.updates.updatedRange);
  } else {
    const sheetRowNumber = existingIndex + 2; // +1 header, +1 for 1-indexing
    console.log(`setSettingValue: found "${key}" at sheet row ${sheetRowNumber} — updating Settings!B${sheetRowNumber}`);
    const updateRes = await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Settings!B${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[value]] },
    });
    console.log('setSettingValue: update response ->', JSON.stringify(updateRes.data));

    // Read the cell straight back so the log proves what's actually sitting
    // in the Sheet right now, not just what the API claims it wrote.
    const verify = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `Settings!B${sheetRowNumber}`,
    });
    console.log(`setSettingValue: read-back of Settings!B${sheetRowNumber} ->`, JSON.stringify(verify.data.values));
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

// Returns the existing Patient ID for this phone if one is already on
// record, otherwise generates and returns a brand new one (PT-000001, ...).
// Does NOT write anything itself — the caller is expected to pass the
// result into upsertPatientProfile so it gets persisted.
async function getOrCreatePatientId(phone) {
  const { header, rows } = await readTab('Patients');
  const phoneIdx = header.indexOf('Phone Number');
  const idIdx = header.indexOf('Patient ID');
  if (phoneIdx !== -1) {
    const row = rows.find((r) => stripQuote(r[phoneIdx]) === phone);
    if (row && idIdx !== -1 && (row[idIdx] || '').trim()) {
      return row[idIdx].trim();
    }
  }
  return generatePatientId();
}

async function upsertPatientProfile(phone, { name, age, lang, lastVisitDate, patientId }) {
  const sheets = await getSheetsClient();
  const { header, rows } = await readTab('Patients');
  const phoneIdx = header.indexOf('Phone Number');

  const newRow = [
    `'${phone}`,
    name || '',
    age || '',
    lang || '',
    lastVisitDate ? `'${lastVisitDate}` : '',
    patientId || '',
  ];

  const existingIndex = phoneIdx === -1 ? -1 : rows.findIndex((r) => stripQuote(r[phoneIdx]) === phone);

  if (existingIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Patients!A:F',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] },
    });
  } else {
    const sheetRowNumber = existingIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Patients!A${sheetRowNumber}:F${sheetRowNumber}`,
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
async function getLastVisitDate(phone) {
  const { header, rows } = await readTab('Bookings');
  const phoneIdx = header.indexOf('Phone Number');
  const dateIdx = header.indexOf('Date');
  if (phoneIdx === -1 || dateIdx === -1) return null;

  const matches = rows.filter((r) => stripQuote(r[phoneIdx]) === phone);
  if (matches.length === 0) return null;

  const dates = matches.map((r) => stripQuote(r[dateIdx])).filter(Boolean).sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

// "New" or "Follow-up", based on Case Paper Validity Days from Settings.
async function getVisitType(phone) {
  const lastVisit = await getLastVisitDate(phone);
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
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Capacity!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
  }

  return { daysAhead, slotsPerDay: dailySlots.length, added: newRows.length };
}

// ---------- Bookings ----------

async function appendBooking({
  name,
  age,
  reason,
  date,
  slot,
  token,
  phone,
  paymentStatus,
  visitType,
  bookingId,
  casePaperNumber,
  patientId,
}) {
  const sheets = await getSheetsClient();
  // Column order here MUST match the actual Bookings tab:
  // Timestamp | Phone Number | Name | Age | Reason | Date | Slot | Token Number | Payment Status | Visit Type | Booking ID | Case Paper Number | Patient ID
  //
  // Date and Slot are written with a leading apostrophe (same trick as
  // phone numbers) to STOP Google Sheets from auto-converting "2026-09-05"
  // into a real Date type (which then displays as a serial number like
  // 46270 and can never text-match what the bot compares against).
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bookings!A:M',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [
        [
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
          bookingId || '',
          casePaperNumber || '',
          patientId || '',
        ],
      ],
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
  const sheets = await getSheetsClient();
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
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Pending!A:I',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] },
    });
  } else {
    // +2 = +1 for header row, +1 because Sheets ranges are 1-indexed
    const sheetRowNumber = existingIndex + 2;
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

// ---------- Automatic numbering system (Counters tab) ----------
// Backed by a "Counters" tab: Counter Type | Current Value | Updated At.
//
// CONCURRENCY NOTE: the Google Sheets API has no atomic "increment" call.
// This does a read -> compute next -> write -> re-read-to-verify loop with
// a few retries. At clinic scale (a handful of bookings happening around
// the same time, not thousands per second) this is safe in practice, even
// though it isn't a mathematically perfect lock. If two requests ever did
// collide, the verify step catches it and retries with a fresh number
// rather than silently handing out a duplicate.
//
// This phase ONLY adds the numbering infrastructure — it is not yet wired
// into the booking flow, so nothing about the existing working system
// changes yet. That wiring is a deliberate later step (Phase 2).

async function getNextNumber(counterType) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const sheets = await getSheetsClient();
    const { rows } = await readTab('Counters');

    const existingIndex = rows.findIndex((r) => (r[0] || '').trim() === counterType);
    const current = existingIndex === -1 ? 0 : parseInt(rows[existingIndex][1], 10) || 0;
    const next = current + 1;
    const now = new Date().toISOString();

    if (existingIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Counters!A:C',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[counterType, next, now]] },
      });
    } else {
      const rowNum = existingIndex + 2; // +1 header, +1 for 1-indexing
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Counters!B${rowNum}:C${rowNum}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[next, now]] },
      });
    }

    // Verify nobody else raced us to the same counter in the meantime.
    const verify = await readTab('Counters');
    const vIndex = verify.rows.findIndex((r) => (r[0] || '').trim() === counterType);
    const confirmed = vIndex === -1 ? null : parseInt(verify.rows[vIndex][1], 10);

    if (confirmed === next) {
      return next;
    }
    // Someone else won the race — brief random wait, then retry with a
    // fresh read (so we build on whatever value they left behind).
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 250));
  }
  throw new Error(`getNextNumber: could not safely increment counter "${counterType}" after several attempts.`);
}

function padNumber(n, width) {
  return String(n).padStart(width, '0');
}

// PT-000001, PT-000002, ...
async function generatePatientId() {
  const n = await getNextNumber('PatientID');
  return `PT-${padNumber(n, 6)}`;
}

// APT-2026-000001, resets implicitly each year since the counter key
// includes the year.
async function generateAppointmentId() {
  const year = new Date().getFullYear();
  const n = await getNextNumber(`AppointmentID-${year}`);
  return `APT-${year}-${padNumber(n, 6)}`;
}

// CP-2026-000001
async function generateCasePaperNumber() {
  const year = new Date().getFullYear();
  const n = await getNextNumber(`CasePaper-${year}`);
  return `CP-${year}-${padNumber(n, 6)}`;
}

// REC-2026-000001
async function generateRecordNumber() {
  const year = new Date().getFullYear();
  const n = await getNextNumber(`Record-${year}`);
  return `REC-${year}-${padNumber(n, 6)}`;
}

// RX-2026-000001
async function generatePrescriptionNumber() {
  const year = new Date().getFullYear();
  const n = await getNextNumber(`Prescription-${year}`);
  return `RX-${year}-${padNumber(n, 6)}`;
}

// 001, 002, ... — resets each day since the counter key includes the date.
// NOTE: not wired into the live booking flow yet (which still uses the
// existing daily-queue-position logic in getNextAvailableTokenForSlot) —
// available for Phase 2 to switch over to, or use in parallel.
async function generateDailyToken(dateStr) {
  const n = await getNextNumber(`DailyToken-${dateStr}`);
  return padNumber(n, 3);
}

// ---------- Patient Profile secure link (Phase 3) ----------
// Extended Patients columns (appended after Patient ID, so nothing existing
// shifts): Profile Token | Profile Token Expiry | Profile Completed | DOB |
// Gender | Address | City | Blood Group | Allergies | Medical History |
// Current Medicines | Emergency Contact Name | Emergency Contact Relation |
// Emergency Contact Phone  (columns G through T)
//
// Security: the link uses only this random unguessable token — never the
// phone number or Patient ID — and expires after a configurable number of
// days.

function generateProfileToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars, unguessable
}

// Issues (or reissues) a profile-update token for this phone. Assumes a
// Patients row for this phone already exists (call this after
// upsertPatientProfile has run for the same booking).
async function issueProfileToken(phone, validDays = 30) {
  const sheets = await getSheetsClient();
  const { header, rows } = await readTab('Patients');
  const phoneIdx = header.indexOf('Phone Number');
  const existingIndex = phoneIdx === -1 ? -1 : rows.findIndex((r) => stripQuote(r[phoneIdx]) === phone);
  if (existingIndex === -1) return null;

  const token = generateProfileToken();
  const expiry = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString();
  const rowNum = existingIndex + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Patients!G${rowNum}:H${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[token, expiry]] },
  });

  return token;
}

// Looks up a patient by their profile token only — returns null if not
// found or expired. Never accepts phone/Patient ID directly.
async function getPatientByProfileToken(token) {
  const { header, rows } = await readTab('Patients');
  const tokenIdx = header.indexOf('Profile Token');
  const expiryIdx = header.indexOf('Profile Token Expiry');
  if (tokenIdx === -1) return null;

  const row = rows.find((r) => (r[tokenIdx] || '').trim() === token);
  if (!row) return null;

  if (expiryIdx !== -1) {
    const expiry = row[expiryIdx];
    if (expiry && new Date(expiry).getTime() < Date.now()) return null; // expired
  }

  return rowToObject(header, row);
}

// Saves the extended profile fields the patient filled in themselves.
async function updatePatientProfileDetails(phone, details) {
  const sheets = await getSheetsClient();
  const { header, rows } = await readTab('Patients');
  const phoneIdx = header.indexOf('Phone Number');
  const existingIndex = phoneIdx === -1 ? -1 : rows.findIndex((r) => stripQuote(r[phoneIdx]) === phone);
  if (existingIndex === -1) return false;

  const rowNum = existingIndex + 2;
  const values = [
    'Yes', // Profile Completed
    details.dob || '',
    details.gender || '',
    details.address || '',
    details.city || '',
    details.bloodGroup || '',
    details.allergies || '',
    details.medicalHistory || '',
    details.currentMedicines || '',
    details.emergencyName || '',
    details.emergencyRelation || '',
    details.emergencyPhone || '',
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Patients!I${rowNum}:T${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
  return true;
}

module.exports = {
  getSettings,
  setSettingValue,
  getNextNumber,
  generatePatientId,
  generateAppointmentId,
  generateCasePaperNumber,
  generateRecordNumber,
  generatePrescriptionNumber,
  generateDailyToken,
  getPatientProfile,
  getOrCreatePatientId,
  upsertPatientProfile,
  issueProfileToken,
  getPatientByProfileToken,
  updatePatientProfileDetails,
  getVisitType,
  getLastVisitDate,
  getBookingsForDate,
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
};
