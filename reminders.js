// reminders.js
// Sends a WhatsApp reminder to patients whose appointment is coming up
// within `Reminder Hours Before` (a Settings value, default 2 hours).
// Runs on a timer from server.js (like slot generation) — not a route.
//
// Idempotent: marks 'Reminder Sent' = 'Yes' on the Bookings row right
// after sending, so re-running the check (every ~20 minutes) never
// double-sends. Only touches bookings that are still actually upcoming
// (Booking Status = Confirmed, Queue Status still Waiting) — a booking
// that's already been checked in, completed, or cancelled is left alone.

const sheets = require('./sheets');
const whatsapp = require('./whatsapp');
const { getMessages } = require('./messages');

function istNow() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  return new Date(istMs);
}

// "5:30 PM" + "2026-09-19" -> a Date representing that moment in IST,
// expressed as a UTC-equivalent timestamp comparable to istNow().
function parseSlotDateTime(dateStr, slotStr) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((slotStr || '').trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const isPm = m[3].toUpperCase() === 'PM';
  if (hour === 12) hour = isPm ? 12 : 0;
  else if (isPm) hour += 12;

  const [y, mo, d] = (dateStr || '').split('-').map((n) => parseInt(n, 10));
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d, hour, minute, 0);
}

async function sendDueReminders() {
  const settings = await sheets.getSettings();
  const hoursBefore = parseFloat(settings.reminderHoursBefore) || 2;
  const now = istNow();
  const windowEnd = new Date(now.getTime() + hoursBefore * 60 * 60 * 1000);

  const { header, rows } = await sheets.readTab('Bookings');
  const statusIdx = header.indexOf('Booking Status');
  const queueStatusIdx = header.indexOf('Queue Status');
  if (header.indexOf('Reminder Sent') === -1) return { checked: rows.length, sent: 0 }; // schema not upgraded yet

  let sent = 0;
  for (const r of rows) {
    const obj = sheets.rowToObject(header, r);
    if ((obj['Reminder Sent'] || '').trim().toLowerCase() === 'yes') continue;
    if (statusIdx !== -1 && obj['Booking Status'] && obj['Booking Status'] !== 'Confirmed') continue;
    if (queueStatusIdx !== -1 && obj['Queue Status'] && !['Waiting', 'Checked-In'].includes(obj['Queue Status'])) continue;

    const apptTime = parseSlotDateTime(sheets.stripQuote(obj.Date), sheets.stripQuote(obj.Slot));
    if (!apptTime) continue;
    if (apptTime < now || apptTime > windowEnd) continue; // not due yet, or already passed

    try {
      const phone = sheets.stripQuote(obj['Phone Number']);
      const patient = await sheets.getPatientProfileByPhoneAndName(phone, obj.Name);
      const lang = (patient && patient.Lang) || 'mr';
      const M = getMessages(lang);
      const reminderText =
        M.appointmentReminder && typeof M.appointmentReminder === 'function'
          ? M.appointmentReminder(obj.Name, sheets.stripQuote(obj.Date), sheets.stripQuote(obj.Slot), obj['Token Number'])
          : `🔔 Reminder: ${obj.Name}, your appointment is today at ${sheets.stripQuote(obj.Slot)} (Token ${obj['Token Number']}).`;
      await whatsapp.sendText(phone, reminderText);

      if (obj['Booking ID']) {
        await sheets.updateBookingByBookingId(obj['Booking ID'], { 'Reminder Sent': 'Yes' });
      }
      sent++;
    } catch (err) {
      console.warn('reminder send failed for one booking (non-fatal):', err.message);
    }
  }

  return { checked: rows.length, sent };
}

module.exports = { sendDueReminders };
