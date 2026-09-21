// counters.js
// Central place for every auto-generated ID in the system:
//   Patient ID        PT-000001
//   Appointment ID     APT-2026-000001
//   Case Paper Number  CP-2026-000001
//   Medical Record No  REC-2026-000001
//   Prescription No    RX-2026-000001
//   Daily Token        001, 002, 003 (resets every day)
//
// All values live in the "Counters" tab (Counter Type | Current Value |
// Updated At) in the same Google Sheet — no other database is used.
//
// CONCURRENCY NOTE: Google Sheets has no atomic increment / compare-and-set
// call, so two webhook requests hitting the same counter at the exact same
// moment could in theory read the same "current value" and both write the
// same next number. In practice Render runs this app as a single Node
// process, so we close that gap with an in-process per-counter queue
// (withLock below) — every increment for a given counter type is forced to
// run one-at-a-time, in order, even if two requests come in together.
// This is enough for clinic-scale traffic (a handful of bookings at once).
// It would NOT be enough across multiple server instances/processes.

const sheets = require('./sheets');

const locks = new Map();

function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => {
      if (locks.get(key) === settled) locks.delete(key);
    },
    () => {
      if (locks.get(key) === settled) locks.delete(key);
    }
  );
  locks.set(key, settled);
  return run;
}

function pad(num, width) {
  return String(num).padStart(width, '0');
}

// IST year — matches the date convention already used across server.js/sheets.js.
function currentIstYear() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  return new Date(istMs).getFullYear();
}

// Reads current value for a counter key, increments it by 1, persists it,
// and returns the NEW value. Serialized per key via withLock so concurrent
// callers never get the same number.
async function nextSequence(counterType) {
  return withLock(counterType, async () => {
    const current = await sheets.getCounterValue(counterType);
    const next = current + 1;
    await sheets.setCounterValue(counterType, next);
    return next;
  });
}

async function nextPatientId() {
  const seq = await nextSequence('PATIENT');
  return `PT-${pad(seq, 6)}`;
}

async function nextAppointmentId() {
  const year = currentIstYear();
  const seq = await nextSequence(`APPOINTMENT_${year}`);
  return `APT-${year}-${pad(seq, 6)}`;
}

async function nextCasePaperNumber() {
  const year = currentIstYear();
  const seq = await nextSequence(`CASE_PAPER_${year}`);
  return `CP-${year}-${pad(seq, 6)}`;
}

async function nextRecordId() {
  const year = currentIstYear();
  const seq = await nextSequence(`RECORD_${year}`);
  return `REC-${year}-${pad(seq, 6)}`;
}

async function nextPrescriptionId() {
  const year = currentIstYear();
  const seq = await nextSequence(`PRESCRIPTION_${year}`);
  return `RX-${year}-${pad(seq, 6)}`;
}

async function nextFileId() {
  const year = currentIstYear();
  const seq = await nextSequence(`FILE_${year}`);
  return `FIL-${year}-${pad(seq, 6)}`;
}

async function nextExpenseId() {
  const year = currentIstYear();
  const seq = await nextSequence(`EXPENSE_${year}`);
  return `EXP-${year}-${pad(seq, 5)}`;
}

async function nextDoctorId() {
  const seq = await nextSequence('DOCTOR');
  return `DOC-${pad(seq, 3)}`;
}

async function nextStaffId() {
  const seq = await nextSequence('STAFF');
  return `STF-${pad(seq, 3)}`;
}

// dateStr must be the booking's own YYYY-MM-DD (IST) date — the SAME date
// the token is displayed against — not "today", so tokens generated ahead
// of time (or late at night) still key off the correct day's sequence.
async function nextDailyToken(dateStr) {
  const seq = await nextSequence(`TOKEN_${dateStr}`);
  return pad(seq, 3);
}

module.exports = {
  nextPatientId,
  nextAppointmentId,
  nextCasePaperNumber,
  nextRecordId,
  nextPrescriptionId,
  nextFileId,
  nextExpenseId,
  nextDoctorId,
  nextStaffId,
  nextDailyToken,
};
