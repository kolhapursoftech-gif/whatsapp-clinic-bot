// alerts.js
// Sends a WhatsApp message to the clinic's configured alert number when
// something serious goes wrong (an unhandled error, a failed slot
// generation run...). Uses the existing WhatsApp
// infrastructure — no new channel/dependency needed. Email alerting would
// need SMTP credentials this project doesn't have; WhatsApp is what's
// already reliable here.
//
// Rate-limited in-process: the same alert "kind" won't fire more than
// once every RATE_LIMIT_MS, so a repeating error (e.g. Google Sheets down
// for an hour) sends ONE alert, not one per failed request.

const sheets = require('./sheets');
const whatsapp = require('./whatsapp');

const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes
const lastSentAt = new Map();

async function getAlertNumber() {
  const settings = await sheets.getSettings();
  return settings.alertNumber || settings.staffNumber || process.env.DOCTOR_WHATSAPP_NUMBER || '';
}

// `kind` groups repeats of the same problem together for rate-limiting —
// e.g. 'unhandled-error', 'slot-generation-failed'.
async function sendAlert(kind, message) {
  try {
    const now = Date.now();
    const last = lastSentAt.get(kind) || 0;
    if (now - last < RATE_LIMIT_MS) return; // suppressed — too soon after the last one
    lastSentAt.set(kind, now);

    const number = await getAlertNumber();
    if (!number) {
      console.warn('alerts: no Alert WhatsApp Number configured — alert not sent:', message);
      return;
    }
    await whatsapp.sendText(number, `🚨 *Clinic Bot Alert*\n\n${message}`);
  } catch (err) {
    // An alert failing to send must never itself crash anything — just log it.
    console.error('alerts: failed to send alert (non-fatal):', err.message);
  }
}

module.exports = { sendAlert };
