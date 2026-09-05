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
  await sheets.setPendingState(phone, { step: 'ASK_LANGUAGE', name: '', age: '', date: '', slot: '', lang: '' });
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
    date: dateStr,
    lang: state.lang,
  });

  await whatsapp.sendList(phone, M.askSlotBody(dateStr), M.askSlotButtonLabel, rows);
  return true;
}

async function movePatientToPaymentStep(phone, state, settingsObj) {
  const M = getMessages(state.lang);
  await sheets.setPendingState(phone, {
    step: 'AWAITING_PAYMENT_SCREENSHOT',
    name: state.name,
    age: state.age,
    date: state.date,
    slot: state.slot,
    lang: state.lang,
  });
  await whatsapp.sendUpiQr(phone, {
    upiId: settingsObj.upiId,
    amount: settingsObj.feeAmount,
    clinicName: settingsObj.clinicName,
    caption: M.paymentCaption(settingsObj.feeAmount, settingsObj.upiId, settingsObj.clinicName),
  });
}

async function finalizeBooking(phone, name, age, dateStr, slot, token, opts = {}) {
  await sheets.appendBooking({
    name,
    age,
    date: dateStr,
    slot,
    token,
    phone,
    paymentStatus: opts.paymentStatus || 'Paid',
  });
  await sheets.clearPendingState(phone);

  const M = getMessages(opts.lang);
  await whatsapp.sendText(
    phone,
    M.bookingConfirmed(opts.clinicName || CLINIC_NAME_FALLBACK, name, token, dateStr, slot)
  );

  const notifyNumber = opts.staffNumber || DOCTOR_NUMBER;
  if (notifyNumber) {
    await whatsapp.sendText(
      notifyNumber,
      `Naveen Booking: ${name} (${age}) - Token #${token} - ${dateStr} ${slot} (Payment: ${opts.paymentStatus || 'Paid'})`
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

  await finalizeBooking(pending.phone, pending.name, pending.age, pending.date, pending.slot, token, {
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

    // ---- Staff replying "CONFIRM 9876" to approve a payment screenshot ----
    if (staffNumber && from === staffNumber && text && CONFIRM_REGEX.test(text)) {
      const lastDigits = text.match(CONFIRM_REGEX)[1];
      await handleStaffConfirm(lastDigits, staffNumber, clinicName);
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
        step: 'ASK_DATE',
        name: state.name,
        age: String(age),
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
          await whatsapp.forwardImage(
            staffNumber,
            imageId,
            `Payment screenshot - ${state.name} (${state.age}), ${state.date} ${state.slot}, phone ending ${from.slice(-4)}.\nReply "CONFIRM ${from.slice(-4)}" to confirm and issue a token.`
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
