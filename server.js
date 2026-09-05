// server.js
require('dotenv').config();

const express = require('express');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const groq = require('./groq');

const app = express();
app.use(express.json());

const CLINIC_NAME = process.env.CLINIC_NAME || 'the clinic';
const DOCTOR_NUMBER = process.env.DOCTOR_WHATSAPP_NUMBER; // fallback if Settings tab has none
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

const CONFIRM_REGEX = /^CONFIRM\s+(\d{3,4})$/i;

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

    await sheets.setPendingState(phone, { step: 'ASK_NAME', name: '', age: '', date: '' });
    await whatsapp.sendText(
      phone,
      `Namaskar! ${CLINIC_NAME} madhe swagat aahe. Appointment book karayla, kripaya tumche purna naav sanga.`
    );
    return res.sendStatus(200);
  } catch (err) {
    console.error('trigger-missed-call error:', err.message);
    return res.sendStatus(500);
  }
});

// ---------- helpers used by the webhook handler ----------

async function movePatientToPaymentStep(phone, currentState, dateStr, settingsObj) {
  await sheets.setPendingState(phone, {
    step: 'AWAITING_PAYMENT_SCREENSHOT',
    name: currentState.name,
    age: currentState.age,
    date: dateStr,
  });
  await whatsapp.sendUpiQr(phone, {
    upiId: settingsObj.upiId,
    amount: settingsObj.feeAmount,
    clinicName: settingsObj.clinicName || CLINIC_NAME,
    caption: `Appointment fee: Rs ${settingsObj.feeAmount}\nUPI ID: ${settingsObj.upiId}\n\nQR scan karun payment kara, ani payment cha screenshot ithech pathva.`,
  });
}

async function finalizeBooking(phone, name, age, dateStr, token, opts = {}) {
  await sheets.appendBooking({
    name,
    age,
    date: dateStr,
    token,
    phone,
    paymentStatus: opts.paymentStatus || 'Paid',
  });
  await sheets.clearPendingState(phone);

  await whatsapp.sendText(
    phone,
    `Booking confirm zali!\nNaav: ${name}\nToken Number: ${token}\nDate: ${dateStr}\n\nKripaya tumcha token number sobat ghevun ya.`
  );

  const notifyNumber = opts.staffNumber || DOCTOR_NUMBER;
  if (notifyNumber) {
    await whatsapp.sendText(
      notifyNumber,
      `Naveen Booking: ${name} (${age}) - Token #${token} - ${dateStr} (Payment: ${opts.paymentStatus || 'Paid'})`
    );
  }
}

async function handleStaffConfirm(lastDigits, staffNum) {
  const pending = await sheets.findPendingByLastDigits(lastDigits, 'AWAITING_STAFF_CONFIRM');
  if (!pending) {
    await whatsapp.sendText(staffNum, `Konatehi pending payment "${lastDigits}" ne sampat nahi. Tapasun parat pathva.`);
    return;
  }

  const token = await sheets.getNextAvailableToken(pending.date);
  if (token === null) {
    await whatsapp.sendText(staffNum, `${pending.date} cha divas ata full zala aahe. Patient la sanga vegla divas nivda.`);
    await whatsapp.sendText(pending.phone, 'Kshama kara, tumcha divas ata full zala aahe. Kripaya doctor shi sampark sadha.');
    return;
  }

  await finalizeBooking(pending.phone, pending.name, pending.age, pending.date, token, {
    paymentStatus: 'Paid',
    staffNumber: staffNum,
  });
  await whatsapp.sendText(staffNum, `Confirm zala. Token #${token} patient la pathavla.`);
}

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
    const clinicName = settings.clinicName || CLINIC_NAME;

    // ---- Staff replying "CONFIRM 9876" to approve a payment screenshot ----
    if (staffNumber && from === staffNumber && text && CONFIRM_REGEX.test(text)) {
      const lastDigits = text.match(CONFIRM_REGEX)[1];
      await handleStaffConfirm(lastDigits, staffNumber);
      return;
    }

    let state = await sheets.getPendingState(from);
    console.log('Current pending state:', JSON.stringify(state));
    if (!state || state.step === 'DONE' || !state.step) {
      // Fresh conversation (patient messaged in without going through the
      // missed-call trigger, or their previous booking is already complete).
      state = { step: 'ASK_NAME', name: '', age: '', date: '' };
      await sheets.setPendingState(from, state);
      await whatsapp.sendText(
        from,
        `Namaskar! ${clinicName} madhe swagat aahe. Appointment book karayla, kripaya tumche purna naav sanga.`
      );
      return;
    }

    if (state.step === 'ASK_NAME') {
      if (!text || text.trim().length < 2) {
        const reply = await groq.getFallbackReply(text || '', 'ASK_NAME');
        await whatsapp.sendText(from, reply);
        return;
      }
      await sheets.setPendingState(from, { step: 'ASK_AGE', name: text.trim(), age: '', date: '' });
      await whatsapp.sendText(from, `Dhanyawad, ${text.trim()}. Aata tumche vay (age) sanga.`);
      return;
    }

    if (state.step === 'ASK_AGE') {
      const age = parseInt(text, 10);
      if (!text || isNaN(age) || age <= 0 || age > 120) {
        const reply = await groq.getFallbackReply(text || '', 'ASK_AGE');
        await whatsapp.sendText(from, reply);
        return;
      }
      await sheets.setPendingState(from, { step: 'ASK_DATE', name: state.name, age: String(age), date: '' });
      await whatsapp.sendButtons(from, 'Appointment kevha havi aahe?', [
        { id: 'today', title: 'Aaj' },
        { id: 'tomorrow', title: 'Udya' },
      ]);
      return;
    }

    if (state.step === 'ASK_DATE') {
      let offsetDays = null;
      if (buttonId === 'today' || /^aaj$/i.test(text || '')) offsetDays = 0;
      else if (buttonId === 'tomorrow' || /^udya$/i.test(text || '')) offsetDays = 1;

      if (offsetDays === null) {
        // Didn't use the buttons / typed something else — re-show the buttons.
        await whatsapp.sendButtons(from, 'Kripaya button dabun date select kara:', [
          { id: 'today', title: 'Aaj' },
          { id: 'tomorrow', title: 'Udya' },
        ]);
        return;
      }

      const dateStr = istDateString(offsetDays);
      const token = await sheets.getNextAvailableToken(dateStr);

      if (token === null && offsetDays === 0) {
        // Today full -> offer tomorrow automatically.
        const tomorrowStr = istDateString(1);
        const tomorrowToken = await sheets.getNextAvailableToken(tomorrowStr);
        if (tomorrowToken === null) {
          await whatsapp.sendText(from, 'Kshama kara, Aaj ani Udya donhi divas full aahet. Kripaya nantar sampark sadha.');
          await sheets.clearPendingState(from);
          return;
        }
        await movePatientToPaymentStep(from, state, tomorrowStr, settings);
        return;
      }

      if (token === null) {
        await whatsapp.sendText(from, 'Kshama kara, ha divas full aahe. Kripaya nantar sampark sadha.');
        await sheets.clearPendingState(from);
        return;
      }

      await movePatientToPaymentStep(from, state, dateStr, settings);
      return;
    }

    if (state.step === 'AWAITING_PAYMENT_SCREENSHOT') {
      if (imageId) {
        if (staffNumber) {
          await whatsapp.forwardImage(
            staffNumber,
            imageId,
            `Payment screenshot - ${state.name} (${state.age}), date ${state.date}, phone ending ${from.slice(-4)}.\nReply "CONFIRM ${from.slice(-4)}" to confirm and issue a token.`
          );
        } else {
          console.warn('No staff number configured (Settings tab / DOCTOR_WHATSAPP_NUMBER) — cannot forward screenshot.');
        }
        await sheets.setPendingState(from, {
          step: 'AWAITING_STAFF_CONFIRM',
          name: state.name,
          age: state.age,
          date: state.date,
        });
        await whatsapp.sendText(from, 'Dhanyawad! Tumcha payment screenshot milala. Staff verify karat aahet, kripaya thoda vel thamba.');
      } else {
        await whatsapp.sendText(from, 'Kripaya payment cha screenshot (photo) pathva.');
      }
      return;
    }

    if (state.step === 'AWAITING_STAFF_CONFIRM') {
      await whatsapp.sendText(from, 'Amhi tumcha payment verify karat aahot. Kripaya thoda vel thamba, confirmation lavkarach yeil.');
      return;
    }
  } catch (err) {
    console.error('webhook handling error:', err.message, err.stack);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp clinic bot listening on port ${PORT}`));
