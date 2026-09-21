// records.js
// Everything to do with a doctor's clinical write-up for one visit:
// diagnosis, notes, and the prescription (medicine list). Persists to the
// Records tab (+ generates a Case Paper Number on the booking the first
// time this visit is opened, if it doesn't have one yet).
//
// Records tab columns: Record ID | Patient ID | Booking ID | Case Paper
// Number | Date | Doctor Name | Reason | Diagnosis | Doctor Notes |
// Prescription ID | Created At
//
// ONE ADDITIONAL COLUMN not in the original spec: "Prescription Items"
// (JSON text) — the actual medicine rows (name/morning/evening/before-
// after-meal/days) the doctor filled in. Without storing these somewhere,
// a saved prescription couldn't be redisplayed later (only the Record ID
// would exist with nothing behind it). Stored as JSON in one cell to avoid
// a 6th new tab for what is really one field of Records.

const sheets = require('./sheets');
const counters = require('./counters');

// Assigns a Case Paper Number to this booking if it doesn't have one yet
// (idempotent — safe to call every time the case paper page is opened).
// Returns the (possibly newly-generated) number.
async function ensureCasePaperNumber(booking) {
  if (booking['Case Paper Number']) return booking['Case Paper Number'];
  const casePaperNumber = await counters.nextCasePaperNumber();
  await sheets.updateBookingByBookingId(booking['Booking ID'], {
    'Case Paper Number': casePaperNumber,
  });
  return casePaperNumber;
}

// Saves the doctor's diagnosis/notes/prescription for a booking. Creates
// ONE Record row per booking (calling it again for the same booking
// overwrites — matched by Booking ID — rather than creating duplicates,
// since a doctor may reopen and edit a case paper before printing).
async function saveDiagnosis({ booking, patientId, doctorId, doctorName, diagnosis, notes, medicines }) {
  const existing = await sheets.getRecordByBookingId(booking['Booking ID']);
  const recordId = (existing && existing['Record ID']) || (await counters.nextRecordId());
  const prescriptionId =
    (existing && existing['Prescription ID']) ||
    (medicines && medicines.length ? await counters.nextPrescriptionId() : '');

  const fields = {
    'Record ID': recordId,
    'Patient ID': patientId,
    'Booking ID': booking['Booking ID'],
    'Case Paper Number': booking['Case Paper Number'] || '',
    Date: sheets.stripQuote(booking.Date),
    'Doctor ID': doctorId || '',
    'Doctor Name': doctorName || '',
    Reason: booking.Reason || '',
    Diagnosis: diagnosis || '',
    'Doctor Notes': notes || '',
    'Prescription ID': prescriptionId,
    'Prescription Items': JSON.stringify(medicines || []),
    'Created At': (existing && existing['Created At']) || new Date().toISOString(),
  };

  // upsertByColumn keyed on Record ID keeps this idempotent on repeat saves.
  await sheets.upsertByColumn('Records', 'Record ID', recordId, fields);
  await sheets.updateBookingByBookingId(booking['Booking ID'], {
    'Booking Status': 'Consulted',
    'Doctor ID': doctorId || booking['Doctor ID'] || '',
  });

  return { recordId, prescriptionId };
}

async function getRecordForBooking(bookingId) {
  return sheets.getRecordByBookingId(bookingId);
}

// Everything the case paper needs about this patient's PAST visits:
// previous record summaries + the standing medical info (allergies,
// history, current medicines) from their extended profile. Looked up by
// (phone, name) — not phone alone — so a family member's allergies never
// bleed into another family member's case paper.
async function getHistoryForCasePaper(phone, name, patientId) {
  const [profile, records] = await Promise.all([
    sheets.getPatientProfileByPhoneAndName(phone, name),
    patientId ? sheets.getRecordsForPatient(patientId) : Promise.resolve([]),
  ]);

  const pastVisits = records
    .filter((r) => r.Diagnosis || r['Doctor Notes'])
    .sort((a, b) => String(b.Date).localeCompare(String(a.Date)))
    .slice(0, 5);

  return {
    allergies: (profile && profile.Allergies) || '',
    medicalHistory: (profile && profile['Medical History']) || '',
    currentMedicines: (profile && profile['Current Medicines']) || '',
    bloodGroup: (profile && profile['Blood Group']) || '',
    pastVisits,
  };
}

module.exports = {
  ensureCasePaperNumber,
  saveDiagnosis,
  getRecordForBooking,
  getHistoryForCasePaper,
};
