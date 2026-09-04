// server.js
require('dotenv').config();

const express = require('express');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const groq = require('./groq');

const app = express();
app.use(express.json());

const CLINIC_NAME = process.env.CLINIC_NAME || 'the clinic';
const DOCTOR_NUMBER = process.env.DOCTOR_WHATSAPP_NUMBER;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

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

    await sheets.setPendingState(phone, { step: 'ASK_NAME', name: '', age: '' });
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

  const { from, text, buttonId } = event;
  console.log(`Parsed event: from=${from} text=${text} buttonId=${buttonId}`);

  try {
    let state = await sheets.getPendingState(from);
    console.log('Current pending state:', JSON.stringify(state));
    if (!state || state.step === 'DONE' || !state.step) {
      // Fresh conversation (patient messaged in without going through the
      // missed-call trigger, or their previous booking is already complete).
      state = { step: 'ASK_NAME', name: '', age: '' };
      await sheets.setPendingState(from, state);
      await whatsapp.sendText(
        from,
        `Namaskar! ${CLINIC_NAME} madhe swagat aahe. Appointment book karayla, kripaya tumche purna naav sanga.`
      );
      return;
    }

    if (state.step === 'ASK_NAME') {
      if (!text || text.trim().length < 2) {
        const reply = await groq.getFallbackReply(text || '', 'ASK_NAME');
        await whatsapp.sendText(from, reply);
        return;
      }
      await sheets.setPendingState(from, { step: 'ASK_AGE', name: text.trim(), age: '' });
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
      await sheets.setPendingState(from, { step: 'ASK_DATE', name: state.name, age: String(age) });
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
      let token = await sheets.getNextAvailableToken(dateStr);

      if (token === null && offsetDays === 0) {
        // Today full -> offer tomorrow automatically.
        const tomorrowStr = istDateString(1);
        const tomorrowToken = await sheets.getNextAvailableToken(tomorrowStr);
        if (tomorrowToken === null) {
          await whatsapp.sendText(from, 'Kshama kara, Aaj ani Udya donhi divas full aahet. Kripaya nantar sampark sadha.');
          await sheets.clearPendingState(from);
          return;
        }
        await finalizeBooking(from, state.name, state.age, tomorrowStr, tomorrowToken);
        return;
      }

      if (token === null) {
        await whatsapp.sendText(from, 'Kshama kara, ha divas full aahe. Kripaya nantar sampark sadha.');
        await sheets.clearPendingState(from);
        return;
      }

      await finalizeBooking(from, state.name, state.age, dateStr, token);
      return;
    }
  } catch (err) {
    console.error('webhook handling error:', err.message, err.stack);
  }
});

async function finalizeBooking(phone, name, age, dateStr, token) {
  await sheets.appendBooking({ name, age, date: dateStr, token, phone });
  await sheets.clearPendingState(phone);

  await whatsapp.sendText(
    phone,
    `Booking confirm zali!\nNaav: ${name}\nToken Number: ${token}\nDate: ${dateStr}\n\nKripaya tumcha token number sobat ghevun ya.`
  );

  if (DOCTOR_NUMBER) {
    await whatsapp.sendText(
      DOCTOR_NUMBER,
      `Naveen Booking: ${name} (${age}) - Token #${token} - ${dateStr}`
    );
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp clinic bot listening on port ${PORT}`));
