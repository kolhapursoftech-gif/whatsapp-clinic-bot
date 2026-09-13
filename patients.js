// patients.js
// Domain logic around a patient's record — separate from sheets.js (raw
// Sheets I/O) and dashboard.js (HTTP routes/HTML). Anything that answers
// "what does it mean for a patient to..." lives here.

const sheets = require('./sheets');
const counters = require('./counters');

// Guarantees a Patient ID exists for this phone number (generating one on
// first booking) and returns it. Safe to call every time a booking is
// finalized — it's a no-op if the patient already has one.
async function ensurePatientId(phone) {
  return sheets.ensurePatientId(phone, counters.nextPatientId);
}

// Bumps Total Visits + Last Visit Date on the Patients row. Call this once
// per finalized (paid/free-confirmed) booking, not on every message.
async function recordVisit(phone, visitDateStr) {
  await sheets.incrementPatientVisitCount(phone, visitDateStr);
}

async function search(query) {
  return sheets.searchPatients(query);
}

async function listAll() {
  return sheets.getAllPatients();
}

async function getByPatientId(patientId) {
  return sheets.getPatientByPatientId(patientId);
}

async function getByPhone(phone) {
  return sheets.getPatientFullProfile(phone);
}

// Builds the "complete digital file" timeline for one patient: every
// booking + every clinical record (diagnosis/prescription), merged and
// sorted oldest -> newest, each tagged with a `kind` so the UI can render
// booking rows and record rows differently.
async function getPatientTimeline(patientId) {
  const [bookings, records, files] = await Promise.all([
    sheets.getBookingsForPatientId(patientId),
    sheets.getRecordsForPatient(patientId),
    sheets.getFilesForPatient(patientId),
  ]);

  const events = [
    ...bookings.map((b) => ({
      kind: 'appointment',
      date: sheets.stripQuote(b.Date),
      data: b,
    })),
    ...records.map((r) => ({
      kind: 'record',
      date: r.Date,
      data: r,
    })),
  ];

  events.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return { events, files };
}

module.exports = {
  ensurePatientId,
  recordVisit,
  search,
  listAll,
  getByPatientId,
  getByPhone,
  getPatientTimeline,
};
