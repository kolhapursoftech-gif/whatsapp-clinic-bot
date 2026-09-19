// patients.js
// Domain logic around a patient's record — separate from sheets.js (raw
// Sheets I/O) and dashboard.js (HTTP routes/HTML). Anything that answers
// "what does it mean for a patient to..." lives here.

const sheets = require('./sheets');
const counters = require('./counters');

// Guarantees a Patient ID exists for THIS SPECIFIC PERSON — (phone, name),
// not phone alone. One WhatsApp number is often shared by a whole family
// booking for different members, and each member needs their own separate
// Patient ID/file, not one shared profile. Safe to call every time a
// booking is finalized — it's a no-op if this person already has one.
async function ensurePatientId(phone, name) {
  return sheets.ensurePatientId(phone, name, counters.nextPatientId);
}

// Bumps Total Visits + Last Visit Date for this specific family member.
// Call this once per finalized (paid/free-confirmed) booking, not on
// every message.
async function recordVisit(phone, name, visitDateStr) {
  await sheets.incrementPatientVisitCount(phone, name, visitDateStr);
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

// Returns the specific family member's profile — pass name when you know
// which one; omitting it falls back to the first Patients row for this
// phone (fine for phone-wide things like language, not for medical info).
async function getByPhone(phone, name) {
  return name ? sheets.getPatientProfileByPhoneAndName(phone, name) : sheets.getPatientFullProfile(phone);
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
