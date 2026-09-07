// server.js
require('dotenv').config();

const express = require('express');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const { getMessages, LANGUAGE_BUTTONS, LANGUAGE_PROMPT } = require('./messages');

const app = express();
app.use(express.json());

const CLINIC_NAME_FALLBACK = process.env.CLINIC_NAME || 'the clinic';
const DOCTOR_NUMBER = process.env.DOCTOR_WHATSAPP_NUMBER; // fallback if Settings tab has none
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

const CONFIRM_REGEX = /^CONFIRM\s+(\d{3,4})$/i;
const LANG_MAP = { lang_mr: 'mr', lang_hi: 'hi', lang_en: 'en' };

// Render sets RENDER_EXTERNAL_URL automatically on most plans. If it's not
// present for your service, set APP_BASE_URL yourself in the environment
// variables to your app's actual URL, e.g. https://your-app.onrender.com
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function buildCasePaperLink({ phone, date, token }) {
  const params = new URLSearchParams({ secret: TRIGGER_SECRET || '', phone, date, token: String(token) });
  return `${APP_BASE_URL}/case-paper?${params.toString()}`;
}

// ---------- date helpers (Asia/Kolkata) ----------

function istDateString(offsetDays = 0) {
  const now = new Date();
  // Shift to IST (UTC+5:30) regardless of server timezone, then add offset days.
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  ist.setDate(ist.getDate() + offsetDays);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, '0');
  const d = String(ist.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------- 1. Webhook verification (Meta calls this once when you set the webhook URL) ----------

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- helpers shared by the missed-call trigger and the webhook handler ----------

async function startConversation(phone) {
  await sheets.setPendingState(phone, {
    step: 'ASK_LANGUAGE',
    name: '',
    age: '',
    reason: '',
    date: '',
    slot: '',
    lang: '',
  });
  await whatsapp.sendButtons(phone, LANGUAGE_PROMPT, LANGUAGE_BUTTONS);
}

// Sends the slot list for a date if any slots are free, storing that date on
// the pending state. Returns true if a list was sent, false if the day is
// fully booked (so the caller can fall back to the next day or apologize).
async function sendSlotList(phone, state, dateStr) {
  const M = getMessages(state.lang);
  const slots = await sheets.getAvailableSlots(dateStr);
  if (slots.length === 0) return false;

  const rows = slots.slice(0, 10).map((s) => ({
    id: s.slot,
    title: s.slot,
    description: `${s.remaining} ${M.slotsLeftLabel}`,
  }));

  await sheets.setPendingState(phone, {
    step: 'ASK_SLOT',
    name: state.name,
    age: state.age,
    reason: state.reason,
    date: dateStr,
    lang: state.lang,
  });

  await whatsapp.sendList(phone, M.askSlotBody(dateStr), M.askSlotButtonLabel, rows);
  return true;
}

async function movePatientToPaymentStep(phone, state, settingsObj) {
  const M = getMessages(state.lang);
  const visitType = await sheets.getVisitType(phone);
  const fee = visitType === 'Follow-up' ? settingsObj.followUpFee : settingsObj.newPatientFee;

  await sheets.setPendingState(phone, {
    step: 'AWAITING_PAYMENT_SCREENSHOT',
    name: state.name,
    age: state.age,
    reason: state.reason,
    date: state.date,
    slot: state.slot,
    lang: state.lang,
  });
  await whatsapp.sendUpiQr(phone, {
    upiId: settingsObj.upiId,
    amount: fee,
    clinicName: settingsObj.clinicName,
    caption: M.paymentCaption(fee, settingsObj.upiId, settingsObj.clinicName, visitType),
  });
}

async function finalizeBooking(phone, name, age, reason, dateStr, slot, token, opts = {}) {
  const visitType = await sheets.getVisitType(phone);

  await sheets.appendBooking({
    name,
    age,
    reason,
    date: dateStr,
    slot,
    token,
    phone,
    paymentStatus: opts.paymentStatus || 'Paid',
    visitType,
  });
  await sheets.clearPendingState(phone);

  const M = getMessages(opts.lang);
  await whatsapp.sendText(
    phone,
    M.bookingConfirmed(opts.clinicName || CLINIC_NAME_FALLBACK, name, token, dateStr, slot)
  );

  const notifyNumber = opts.staffNumber || DOCTOR_NUMBER;
  if (notifyNumber) {
    const casePaperLink = buildCasePaperLink({ phone, date: dateStr, token });
    await whatsapp.sendText(
      notifyNumber,
      `Naveen Booking: ${name} (${age}) - Token #${token} - ${dateStr} ${slot} - ${visitType} (Payment: ${opts.paymentStatus || 'Paid'})\nKaran: ${reason || '-'}\n\n📋 Case Paper: ${casePaperLink}`
    );
  }
}

async function handleStaffConfirm(lastDigits, staffNum, clinicName) {
  const pending = await sheets.findPendingByLastDigits(lastDigits, 'AWAITING_STAFF_CONFIRM');
  if (!pending) {
    await whatsapp.sendText(staffNum, `Konatehi pending payment "${lastDigits}" ne sampat nahi. Tapasun parat pathva.`);
    return;
  }

  const token = await sheets.getNextAvailableTokenForSlot(pending.date, pending.slot);
  if (token === null) {
    await whatsapp.sendText(
      staffNum,
      `${pending.date} ${pending.slot} cha slot ata full zala aahe. Patient la sanga vegla slot nivda.`
    );
    const M = getMessages(pending.lang);
    await whatsapp.sendText(pending.phone, M.slotNowFull);
    return;
  }

  await finalizeBooking(pending.phone, pending.name, pending.age, pending.reason, pending.date, pending.slot, token, {
    paymentStatus: 'Paid',
    staffNumber: staffNum,
    lang: pending.lang,
    clinicName,
  });
  await whatsapp.sendText(staffNum, `Confirm zala. Token #${token} patient la pathavla.`);
}

// ---------- 2. Missed-call trigger ----------
// Generic endpoint: point ANY missed-call/forwarding service at this URL.
// It just needs to POST { "phone": "91XXXXXXXXXX" } with the shared secret.
app.post('/trigger-missed-call', async (req, res) => {
  try {
    if (req.query.secret !== TRIGGER_SECRET && req.headers['x-trigger-secret'] !== TRIGGER_SECRET) {
      return res.sendStatus(401);
    }
    const phone = (req.body.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).send('phone is required');

    await startConversation(phone);
    return res.sendStatus(200);
  } catch (err) {
    console.error('trigger-missed-call error:', err.message);
    return res.sendStatus(500);
  }
});

// ---------- 2b. Admin: auto-generate upcoming Capacity slots ----------
// Visit this URL in a browser (with your TRIGGER_SECRET) whenever you want
// to top up the next few days of time slots, based on the Morning/Evening
// hours, slot duration, and capacity set in the Settings tab. Safe to call
// repeatedly — it skips date+slot combos that already exist.
//
// Example: https://your-app.onrender.com/admin/generate-slots?secret=YOUR_SECRET
app.get('/admin/generate-slots', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) {
    return res.sendStatus(401);
  }
  try {
    const summary = await sheets.generateUpcomingSlots();
    res.send(
      `Slots generated.\nDays ahead: ${summary.daysAhead}\nSlots per day: ${summary.slotsPerDay}\nNew rows added: ${summary.added}`
    );
  } catch (err) {
    console.error('generate-slots error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// ---------- 2c. Case paper / prescription page for the doctor ----------
// Staff/doctor get a link to this page (sent via WhatsApp when a booking is
// confirmed). It shows the patient's details and a blank prescription table
// the doctor can fill in (works fine on a phone/tablet touchscreen thanks to
// contenteditable cells) and print directly from the browser.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCasePaperHtml({ clinicName, clinicAddress, clinicPhone, name, age, reason, date, slot, token, visitType }) {
  const rxRows = Array.from({ length: 12 })
    .map(
      () => `
      <tr>
        <td class="num"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true" class="center"></td>
        <td contenteditable="true" class="center"></td>
        <td contenteditable="true" class="center"></td>
        <td contenteditable="true" class="center"></td>
        <td contenteditable="true" class="center"></td>
      </tr>`
    )
    .join('');

  const contactLine = [clinicAddress, clinicPhone ? `📞 ${clinicPhone}` : '']
    .filter(Boolean)
    .join('  •  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Case Paper - ${escapeHtml(name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 24px; color: #1a1a1a; background: #fff; }
  .sheet { max-width: 820px; margin: 0 auto; }

  .header { text-align: center; padding-bottom: 16px; margin-bottom: 20px; border-bottom: 4px solid #1a5f3f; }
  .header h1 { margin: 0; color: #1a5f3f; font-size: 28px; letter-spacing: 0.02em; }
  .header .contact { margin: 6px 0 0; color: #555; font-size: 12.5px; }
  .header .subtitle { margin: 10px 0 0; color: #1a5f3f; font-size: 13px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; }

  .patient-info { display: flex; flex-wrap: wrap; gap: 12px 28px; background: #f5f8f6; border: 1px solid #d8e3dd; border-radius: 10px; padding: 16px 20px; margin-bottom: 22px; }
  .patient-info div { font-size: 14px; }
  .patient-info span.label { color: #6b7d74; display: block; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
  .patient-info span.value { font-weight: bold; color: #1a1a1a; }
  .badge { display: inline-block; padding: 3px 12px; border-radius: 12px; font-size: 11px; font-weight: bold; }
  .badge.new { background: #fde7cf; color: #a15c00; }
  .badge.followup { background: #d9f0e3; color: #1a5f3f; }

  h2.rx { font-size: 17px; color: #1a5f3f; margin: 0 0 12px; border-left: 4px solid #1a5f3f; padding-left: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #c3cfc9; padding: 10px 8px; font-size: 13px; }
  th { background: #1a5f3f; color: #fff; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em; }
  td.num { text-align: center; color: #999; width: 30px; }
  td.center { text-align: center; }
  td[contenteditable="true"] { min-height: 26px; }
  td[contenteditable="true"]:focus { outline: 2px solid #1a5f3f; background: #fbfffa; }

  .signature-row { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 56px; padding: 0 6px; }
  .signature-block { text-align: center; width: 220px; }
  .signature-line { border-top: 1.5px solid #444; margin-bottom: 6px; height: 34px; }
  .signature-block .label { font-size: 12px; color: #555; }

  .print-btn { display: block; margin: 30px auto 0; padding: 12px 28px; background: #1a5f3f; color: #fff; border: none; border-radius: 8px; font-size: 15px; cursor: pointer; }

  @media print {
    .no-print { display: none !important; }
    body { padding: 0; }
  }
</style>
</head>
<body>
<div class="sheet">

  <div class="header">
    <h1>${escapeHtml(clinicName)}</h1>
    ${contactLine ? `<p class="contact">${escapeHtml(contactLine)}</p>` : ''}
    <p class="subtitle">Case Paper &amp; Prescription</p>
  </div>

  <div class="patient-info">
    <div><span class="label">Patient Name</span><span class="value">${escapeHtml(name)}</span></div>
    <div><span class="label">Age</span><span class="value">${escapeHtml(age)}</span></div>
    <div><span class="label">Token No.</span><span class="value">${escapeHtml(token)}</span></div>
    <div><span class="label">Date</span><span class="value">${escapeHtml(date)}</span></div>
    <div><span class="label">Time</span><span class="value">${escapeHtml(slot)}</span></div>
    <div><span class="label">Visit Type</span>
      <span class="badge ${visitType === 'New' ? 'new' : 'followup'}">${escapeHtml(visitType)}</span>
    </div>
    <div style="flex-basis:100%;"><span class="label">Reason for Visit</span><span class="value">${escapeHtml(reason) || '-'}</span></div>
  </div>

  <h2 class="rx">℞ Prescription</h2>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Medicine Name</th>
        <th>Morning</th>
        <th>Evening</th>
        <th>Before Meal</th>
        <th>After Meal</th>
        <th>Days</th>
      </tr>
    </thead>
    <tbody>
      ${rxRows}
    </tbody>
  </table>

  <div class="signature-row">
    <div class="signature-block">
      <div class="signature-line"></div>
      <div class="label">Date</div>
    </div>
    <div class="signature-block">
      <div class="signature-line"></div>
      <div class="label">Doctor's Signature</div>
    </div>
  </div>

  <button class="print-btn no-print" onclick="window.print()">🖨️ Print Case Paper</button>

</div>
</body>
</html>`;
}

// Example: https://your-app.onrender.com/case-paper?secret=YOUR_SECRET&phone=91xxxxxxxxxx&date=2026-09-05&token=3
app.get('/case-paper', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) {
    return res.sendStatus(401);
  }
  const { phone, date, token } = req.query;
  if (!phone || !date || !token) {
    return res.status(400).send('phone, date and token query params are required.');
  }

  try {
    const settings = await sheets.getSettings();
    const booking = await sheets.findBooking({ phone: String(phone), date: String(date), token: String(token) });
    if (!booking) {
      return res.status(404).send('No matching booking found. Double-check the phone, date and token in the link.');
    }

    const html = buildCasePaperHtml({
      clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
      clinicAddress: settings.clinicAddress,
      clinicPhone: settings.clinicPhone,
      name: booking.Name,
      age: booking.Age,
      reason: booking.Reason,
      date: booking.Date,
      slot: booking.Slot,
      token: booking['Token Number'],
      visitType: booking['Visit Type'],
    });

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('case-paper error:', err.message);
    res.status(500).send('Error loading case paper: ' + err.message);
  }
});

// ---------- 3. Incoming WhatsApp messages ----------

app.post('/webhook', async (req, res) => {
  // Always ack immediately; WhatsApp retries aggressively on non-200s.
  res.sendStatus(200);

  console.log('POST /webhook received:', JSON.stringify(req.body));

  const event = whatsapp.parseIncomingMessage(req.body);
  if (!event || !event.from) {
    console.log('Not a patient message (status update or unparseable) — ignoring.');
    return;
  }

  const { from, text, buttonId, imageId } = event;
  console.log(`Parsed event: from=${from} text=${text} buttonId=${buttonId} imageId=${imageId}`);

  try {
    const settings = await sheets.getSettings();
    const staffNumber = settings.staffNumber || (DOCTOR_NUMBER || '').replace(/\D/g, '');
    const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;

    // ---- Staff replying to approve/hold a payment screenshot ----
    // Accepts either typing "CONFIRM 9876" OR tapping the Confirm/Hold
    // buttons sent alongside the forwarded screenshot.
    if (staffNumber && from === staffNumber) {
      if (text && CONFIRM_REGEX.test(text)) {
        const lastDigits = text.match(CONFIRM_REGEX)[1];
        await handleStaffConfirm(lastDigits, staffNumber, clinicName);
      } else if (buttonId && buttonId.startsWith('confirm_')) {
        const lastDigits = buttonId.replace('confirm_', '');
        await handleStaffConfirm(lastDigits, staffNumber, clinicName);
      } else if (buttonId && buttonId.startsWith('hold_')) {
        const lastDigits = buttonId.replace('hold_', '');
        await whatsapp.sendText(
          staffNumber,
          `⏳ Thik aahe. Jevha khatri hoil tevha *Confirm* button dabaa, kiva "CONFIRM ${lastDigits}" pathva.`
        );
      } else {
        // Any other message from the staff number (typos, "ok", forwarded
        // media, etc.) is ignored here instead of falling through to the
        // patient booking flow below — otherwise the bot would mistakenly
        // start asking the staff member for their name/age.
        console.log(`Ignoring non-actionable message from staff number: "${text}" buttonId=${buttonId}`);
      }
      return;
    }

    let state = await sheets.getPendingState(from);
    console.log('Current pending state:', JSON.stringify(state));

    if (!state || state.step === 'DONE' || !state.step) {
      // Fresh conversation (patient messaged in without going through the
      // missed-call trigger, or their previous booking is already complete).
      await startConversation(from);
      return;
    }

    if (state.step === 'ASK_LANGUAGE') {
      const lang = LANG_MAP[buttonId];
      if (!lang) {
        await whatsapp.sendButtons(from, LANGUAGE_PROMPT, LANGUAGE_BUTTONS);
        return;
      }
      const M = getMessages(lang);
      await sheets.setPendingState(from, { step: 'ASK_NAME', name: '', age: '', date: '', slot: '', lang });
      await whatsapp.sendText(from, M.welcomeAskName(clinicName));
      return;
    }

    // From here on every step has a language already chosen.
    const M = getMessages(state.lang);

    if (state.step === 'ASK_NAME') {
      if (!text || text.trim().length < 2) {
        await whatsapp.sendText(from, M.invalidName);
        return;
      }
      await sheets.setPendingState(from, {
        step: 'ASK_AGE',
        name: text.trim(),
        age: '',
        reason: '',
        date: '',
        slot: '',
        lang: state.lang,
      });
      await whatsapp.sendText(from, M.askAge(text.trim()));
      return;
    }

    if (state.step === 'ASK_AGE') {
      const age = parseInt(text, 10);
      if (!text || isNaN(age) || age <= 0 || age > 120) {
        await whatsapp.sendText(from, M.invalidAge);
        return;
      }
      await sheets.setPendingState(from, {
        step: 'ASK_REASON',
        name: state.name,
        age: String(age),
        reason: '',
        date: '',
        slot: '',
        lang: state.lang,
      });
      await whatsapp.sendText(from, M.askReason);
      return;
    }

    if (state.step === 'ASK_REASON') {
      if (!text || text.trim().length < 2) {
        await whatsapp.sendText(from, M.invalidReason);
        return;
      }
      await sheets.setPendingState(from, {
        step: 'ASK_DATE',
        name: state.name,
        age: state.age,
        reason: text.trim(),
        date: '',
        slot: '',
        lang: state.lang,
      });
      await whatsapp.sendButtons(from, M.askDateBody, M.dateButtons);
      return;
    }

    if (state.step === 'ASK_DATE') {
      let offsetDays = null;
      if (buttonId === 'today') offsetDays = 0;
      else if (buttonId === 'tomorrow') offsetDays = 1;

      if (offsetDays === null) {
        // Didn't use the buttons / typed something else — re-show them.
        await whatsapp.sendButtons(from, M.askDateRetry, M.dateButtons);
        return;
      }

      const dateStr = istDateString(offsetDays);
      const sentToday = await sendSlotList(from, state, dateStr);

      if (!sentToday && offsetDays === 0) {
        // Today full -> try tomorrow automatically.
        const tomorrowStr = istDateString(1);
        const sentTomorrow = await sendSlotList(from, state, tomorrowStr);
        if (!sentTomorrow) {
          await whatsapp.sendText(from, M.allFull);
          await sheets.clearPendingState(from);
        }
        return;
      }

      if (!sentToday) {
        await whatsapp.sendText(from, M.dayFull);
        await sheets.clearPendingState(from);
      }
      return;
    }

    if (state.step === 'ASK_SLOT') {
      if (!buttonId) {
        // Didn't pick from the list — re-send it for the same date.
        const sent = await sendSlotList(from, state, state.date);
        if (!sent) {
          await whatsapp.sendText(from, M.noSlots);
          await sheets.clearPendingState(from);
        }
        return;
      }

      const updatedState = { ...state, slot: buttonId };
      await movePatientToPaymentStep(from, updatedState, settings);
      return;
    }

    if (state.step === 'AWAITING_PAYMENT_SCREENSHOT') {
      if (imageId) {
        if (staffNumber) {
          const last4 = from.slice(-4);
          await whatsapp.forwardImageWithButtons(
            staffNumber,
            imageId,
            `📥 *Payment Screenshot*\n\n👤 ${state.name} (${state.age})\n🩺 ${state.reason || '-'}\n📅 ${state.date}  🕒 ${state.slot}\n📱 ...${last4}`,
            [
              { id: `confirm_${last4}`, title: '✅ Confirm' },
              { id: `hold_${last4}`, title: '⏳ Hold' },
            ]
          );
        } else {
          console.warn('No staff number configured (Settings tab / DOCTOR_WHATSAPP_NUMBER) — cannot forward screenshot.');
        }
        await sheets.setPendingState(from, { ...state, step: 'AWAITING_STAFF_CONFIRM' });
        await whatsapp.sendText(from, M.screenshotReceived);
      } else {
        await whatsapp.sendText(from, M.askForScreenshot);
      }
      return;
    }

    if (state.step === 'AWAITING_STAFF_CONFIRM') {
      await whatsapp.sendText(from, M.stillWaiting);
      return;
    }
  } catch (err) {
    console.error('webhook handling error:', err.message, err.stack);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp clinic bot listening on port ${PORT}`));
