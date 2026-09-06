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
    morningStart: map['Morning Start'] || '',
    morningEnd: map['Morning End'] || '',
    eveningStart: map['Evening Start'] || '',
    eveningEnd: map['Evening End'] || '',
    slotDurationMin: map['Slot Duration Minutes'] || '15',
    maxCapacityPerSlot: map['Max Capacity Per Slot'] || '1',
    daysAhead: map['Days To Generate Ahead'] || '7',
    minNoticeMinutes: map['Minimum Notice Minutes'] || '30',
  };
  settingsCacheAt = now;
  return settingsCache;
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

async function appendBooking({ name, age, reason, date, slot, token, phone, paymentStatus, visitType }) {
  const sheets = await getSheetsClient();
  // Column order here MUST match the actual Bookings tab:
  // Timestamp | Phone Number | Name | Age | Reason | Date | Slot | Token Number | Payment Status | Visit Type
  //
  // Date and Slot are written with a leading apostrophe (same trick as
  // phone numbers) to STOP Google Sheets from auto-converting "2026-09-05"
  // into a real Date type (which then displays as a serial number like
  // 46270 and can never text-match what the bot compares against).
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bookings!A:J',
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

module.exports = {
  getSettings,
  getVisitType,
  getLastVisitDate,
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
