// server.js
// Simple WhatsApp clinic booking bot:
//   missed call -> WhatsApp chat -> name, age, reason, date, time slot
//   -> UPI payment QR -> patient sends screenshot -> staff taps Confirm
//   -> booking is saved in the Google Sheet + patient gets a token.
//
// Staff see everything in the Google Sheet (link is sent on WhatsApp with
// every booking, and staff can send "SHEET" to the bot to get it any time).
require('dotenv').config();

// ---------- Last-resort safety net ----------
// An error inside one handler must never crash the whole server (and with it
// the WhatsApp webhook). Log it, alert the clinic, keep running.
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (server stayed up):', err && err.stack ? err.stack : err);
  try {
    require('./alerts').sendAlert('unhandled-rejection', `An unexpected error occurred:\n${err && err.message ? err.message : err}`);
  } catch (e) {
    // the alert itself failing must never compound the original problem
  }
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (server stayed up):', err && err.stack ? err.stack : err);
  try {
    require('./alerts').sendAlert('uncaught-exception', `An unexpected error occurred:\n${err && err.message ? err.message : err}`);
  } catch (e) {
    // same as above
  }
});

const express = require('express');
const axios = require('axios');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const schema = require('./schema');
const alerts = require('./alerts');
const { getMessages, LANGUAGE_BUTTONS, languagePrompt, SAME_PATIENT_BUTTONS } = require('./messages');

const app = express();
app.use(express.json());

// Lightweight health-check: used by the self-ping below (Render free-tier
// keep-alive). Does not touch Google Sheets, so it never uses API quota.
app.get('/ping', (req, res) => res.status(200).send('OK'));

const CLINIC_NAME_FALLBACK = process.env.CLINIC_NAME || 'the clinic';
const DOCTOR_NUMBER = process.env.DOCTOR_WHATSAPP_NUMBER; // fallback if Settings has no staff number
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const TRIGGER_SECRET = (process.env.TRIGGER_SECRET || '').trim();

const CONFIRM_REGEX = /^CONFIRM\s+(\d{3,4})$/i;
const SHEET_REGEX = /^(sheet|link|sheet link)$/i;
const LANG_MAP = { lang_mr: 'mr', lang_hi: 'hi', lang_en: 'en' };

// Render sets RENDER_EXTERNAL_URL automatically; otherwise set APP_BASE_URL
// to your app's URL, e.g. https://your-app.onrender.com
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

// The Google Sheet staff look at. Built from GOOGLE_SHEET_ID - no extra setup.
const SHEET_LINK = process.env.GOOGLE_SHEET_ID
  ? `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit`
  : '';

function sendUnauthorized(res) {
  return res.status(401).send('Unauthorized');
}

// ---------- date helper (Asia/Kolkata) ----------

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

// ---------- booking conversation helpers ----------

// Decides how to greet an incoming patient:
// 1. Settings "Default Language" set -> skip the language picker.
// 2. Known phone number (Patients tab) -> reuse saved language and ask
//    "is this for you, or someone else?" instead of re-asking name/age.
// 3. Brand-new number -> show the language picker.
async function startConversation(phone) {
  const settings = await sheets.getSettings();
  const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;
  const forcedLang = settings.defaultLanguage; // '' if not set in Settings

  const profile = await sheets.getPatientProfile(phone);
  const lang = forcedLang || (profile && profile.lang) || '';

  if (profile && profile.name) {
    const M = getMessages(lang || 'en');
    await sheets.setPendingState(phone, {
      step: 'ASK_SAME_PATIENT',
      name: profile.name,
      age: profile.age,
      reason: '',
      date: '',
      slot: '',
      lang: lang || 'en',
    });
    await whatsapp.sendText(phone, M.welcomeBack(clinicName, profile.name));
    await whatsapp.sendButtons(phone, M.askSamePatient(profile.name), SAME_PATIENT_BUTTONS);
    return;
  }

  if (forcedLang) {
    const M = getMessages(forcedLang);
    await sheets.setPendingState(phone, {
      step: 'ASK_NAME',
      name: '',
      age: '',
      reason: '',
      date: '',
      slot: '',
      lang: forcedLang,
    });
    await whatsapp.sendText(phone, M.welcomeAskName(clinicName));
    return;
  }

  await sheets.setPendingState(phone, {
    step: 'ASK_LANGUAGE',
    name: '',
    age: '',
    reason: '',
    date: '',
    slot: '',
    lang: '',
  });
  await whatsapp.sendButtons(phone, languagePrompt(clinicName), LANGUAGE_BUTTONS);
}

// Sends the slot list for a date if any slots are free. Returns true if a
// list was sent, false if the day is fully booked.
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

// After the patient picks a slot: send the UPI QR (or, if the fee is 0,
// skip payment and just ask staff to confirm).
async function movePatientToPaymentStep(phone, state, settingsObj) {
  const M = getMessages(state.lang);
  const fee = settingsObj.feeAmount;
  const feeNum = parseInt(fee, 10) || 0;
  const staffNumber = settingsObj.staffNumber || (DOCTOR_NUMBER || '').replace(/\D/g, '');

  if (feeNum === 0) {
    await sheets.setPendingState(phone, { ...state, step: 'AWAITING_STAFF_CONFIRM' });
    await whatsapp.sendText(phone, M.freeAppointmentMessage());

    if (staffNumber) {
      const last4 = phone.slice(-4);
      await whatsapp.sendButtons(
        staffNumber,
        `🆓 *Free Booking*\n\n👤 ${state.name} (${state.age})\n🩺 ${state.reason || '-'}\n📅 ${state.date}  🕒 ${state.slot}\n📱 ...${last4}`,
        [
          { id: `confirm_${last4}`, title: '✅ Confirm' },
          { id: `hold_${last4}`, title: '⏳ Hold' },
        ]
      );
    } else {
      console.warn('No staff number configured - cannot notify staff about free booking.');
    }
    return;
  }

  await sheets.setPendingState(phone, { ...state, step: 'AWAITING_PAYMENT_SCREENSHOT' });
  await whatsapp.sendUpiQr(phone, {
    upiId: settingsObj.upiId,
    amount: fee,
    clinicName: settingsObj.clinicName,
    caption: M.paymentCaption(fee, settingsObj.upiId, settingsObj.clinicName),
  });
}

// Saves the confirmed booking into the Sheet, tells the patient, and tells
// staff (with the Sheet link).
async function finalizeBooking(phone, name, age, reason, dateStr, slot, token, opts = {}) {
  const settings = await sheets.getSettings();
  const feeAmount = opts.paymentStatus === 'Free' ? 0 : parseInt(settings.feeAmount, 10) || 0;

  // Written BY HEADER NAME, so the column order in the Sheet does not matter.
  // Date/Slot/Phone get a leading apostrophe so Sheets keeps them as text.
  await sheets.appendBookingRow({
    Timestamp: new Date().toISOString(),
    'Phone Number': `'${phone}`,
    Name: name,
    Age: age,
    Reason: reason || '',
    Date: `'${dateStr}`,
    Slot: `'${slot}`,
    'Token Number': token,
    'Payment Status': opts.paymentStatus || 'Paid',
    Fee: feeAmount,
    'Booking Status': 'Confirmed',
  });

  await sheets.upsertPatientProfile(phone, { name, age, lang: opts.lang, lastVisitDate: dateStr });
  await sheets.clearPendingState(phone);

  const M = getMessages(opts.lang);
  await whatsapp.sendText(phone, M.bookingConfirmed(opts.clinicName || CLINIC_NAME_FALLBACK, name, token, dateStr, slot));

  const notifyNumber = opts.staffNumber || DOCTOR_NUMBER;
  if (notifyNumber) {
    const sheetLine = SHEET_LINK ? `\n\n📊 Sheet: ${SHEET_LINK}` : '';
    await whatsapp.sendText(
      notifyNumber,
      `Naveen Booking: ${name} (${age}) - Token #${token} - ${dateStr} ${slot} (Payment: ${opts.paymentStatus || 'Paid'})\nKaran: ${reason || '-'}${sheetLine}`
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

  const settings = await sheets.getSettings();
  const paymentStatus = (parseInt(settings.feeAmount, 10) || 0) === 0 ? 'Free' : 'Paid';

  await finalizeBooking(pending.phone, pending.name, pending.age, pending.reason, pending.date, pending.slot, token, {
    paymentStatus,
    staffNumber: staffNum,
    lang: pending.lang,
    clinicName,
  });
  await whatsapp.sendText(staffNum, `Confirm zala. Token #${token} patient la pathavla.`);
}

// ---------- 2. Missed-call trigger ----------
// Point ANY missed-call/forwarding service at this URL. It just needs to
// POST { "phone": "91XXXXXXXXXX" } with the shared secret.
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

// ---------- 2b. Admin helpers (protected by TRIGGER_SECRET) ----------

// Top up the next few days of time slots (also runs automatically every day).
// Example: https://your-app.onrender.com/admin/generate-slots?secret=YOUR_SECRET
app.get('/admin/generate-slots', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return sendUnauthorized(res);
  try {
    const summary = await sheets.generateUpcomingSlots();
    res.send(`Slots generated.\nDays ahead: ${summary.daysAhead}\nSlots per day: ${summary.slotsPerDay}\nNew rows added: ${summary.added}`);
  } catch (err) {
    console.error('generate-slots error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// Re-runs the Sheet auto-setup (tabs/columns/default Settings) on demand.
app.get('/admin/ensure-schema', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return sendUnauthorized(res);
  try {
    const report = await schema.ensureSheetSchema();
    res.json(report);
  } catch (err) {
    console.error('ensure-schema error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shows exactly what the server sees in the Bookings tab (handy when a date
// does not seem to match).
app.get('/admin/debug-bookings', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return sendUnauthorized(res);
  try {
    const todayComputed = req.query.date || istDateString(0);
    const { header, rows } = await sheets.readTab('Bookings');
    const dateIdx = header.indexOf('Date');

    const allRows = rows.map((r, i) => ({
      sheetRow: i + 2,
      Date_raw: r[dateIdx],
      Date_stripped: dateIdx !== -1 ? sheets.stripQuote(r[dateIdx]).trim() : null,
      Name: r[header.indexOf('Name')],
      Token: r[header.indexOf('Token Number')],
      matchesToday: dateIdx !== -1 && sheets.stripQuote(r[dateIdx]).trim() === todayComputed.trim(),
    }));

    res.json({
      serverComputedToday: todayComputed,
      totalRowsInSheet: rows.length,
      header,
      rowsMatchingToday: allRows.filter((r) => r.matchesToday).length,
      last10Rows: allRows.slice(-10),
    });
  } catch (err) {
    console.error('debug-bookings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 3. Incoming WhatsApp messages ----------

app.post('/webhook', async (req, res) => {
  // Always ack immediately; WhatsApp retries aggressively on non-200s.
  res.sendStatus(200);

  const event = whatsapp.parseIncomingMessage(req.body);
  if (!event || !event.from) return; // status update or unparseable

  const { from, text, buttonId, imageId } = event;
  console.log(`Incoming: from=${from} text=${text} buttonId=${buttonId} imageId=${imageId}`);

  try {
    const settings = await sheets.getSettings();
    const staffNumber = settings.staffNumber || (DOCTOR_NUMBER || '').replace(/\D/g, '');
    const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;

    // ---- Staff: tap Confirm/Hold on a payment, or ask for the Sheet link ----
    if (staffNumber && from === staffNumber) {
      if (text && CONFIRM_REGEX.test(text)) {
        await handleStaffConfirm(text.match(CONFIRM_REGEX)[1], staffNumber, clinicName);
      } else if (buttonId && buttonId.startsWith('confirm_')) {
        await handleStaffConfirm(buttonId.replace('confirm_', ''), staffNumber, clinicName);
      } else if (buttonId && buttonId.startsWith('hold_')) {
        const lastDigits = buttonId.replace('hold_', '');
        await whatsapp.sendText(
          staffNumber,
          `⏳ Thik aahe. Jevha khatri hoil tevha *Confirm* button dabaa, kiva "CONFIRM ${lastDigits}" pathva.`
        );
      } else if (text && SHEET_REGEX.test(text)) {
        await whatsapp.sendText(staffNumber, SHEET_LINK ? `📊 Sheet: ${SHEET_LINK}` : 'Sheet link available nahi (GOOGLE_SHEET_ID set nahi).');
      } else {
        // Anything else from the staff number is ignored - otherwise the bot
        // would start asking the staff member for their name/age.
        console.log(`Ignoring non-actionable message from staff number: "${text}" buttonId=${buttonId}`);
      }
      return;
    }

    const state = await sheets.getPendingState(from);

    if (!state || state.step === 'DONE' || !state.step) {
      // Fresh conversation (patient messaged in without a missed call, or
      // their previous booking is already complete).
      await startConversation(from);
      return;
    }

    if (state.step === 'ASK_LANGUAGE') {
      const lang = LANG_MAP[buttonId];
      if (!lang) {
        await whatsapp.sendButtons(from, languagePrompt(clinicName), LANGUAGE_BUTTONS);
        return;
      }
      const M = getMessages(lang);
      await sheets.setPendingState(from, { step: 'ASK_NAME', name: '', age: '', reason: '', date: '', slot: '', lang });
      await whatsapp.sendText(from, M.welcomeAskName(clinicName));
      return;
    }

    // From here on every step has a language already chosen.
    const M = getMessages(state.lang);

    if (state.step === 'ASK_SAME_PATIENT') {
      if (buttonId === 'same_patient') {
        await sheets.setPendingState(from, {
          step: 'ASK_REASON',
          name: state.name,
          age: state.age,
          reason: '',
          date: '',
          slot: '',
          lang: state.lang,
        });
        await whatsapp.sendText(from, M.askReason);
        return;
      }
      if (buttonId === 'different_patient') {
        await sheets.setPendingState(from, { step: 'ASK_NAME', name: '', age: '', reason: '', date: '', slot: '', lang: state.lang });
        await whatsapp.sendText(from, M.welcomeAskName(clinicName));
        return;
      }
      await whatsapp.sendButtons(from, M.askSamePatient(state.name), SAME_PATIENT_BUTTONS);
      return;
    }

    if (state.step === 'ASK_NAME') {
      const cleanedName = (text || '').trim();
      const isGreetingJunk = /^(hi|hii|hello|hey|test|ok|okay|namaste|namaskar)$/i.test(cleanedName);
      if (!cleanedName || cleanedName.length < 2 || isGreetingJunk) {
        await whatsapp.sendText(from, M.invalidName);
        return;
      }
      await sheets.setPendingState(from, { step: 'ASK_AGE', name: cleanedName, age: '', reason: '', date: '', slot: '', lang: state.lang });
      await whatsapp.sendText(from, M.askAge(cleanedName));
      return;
    }

    if (state.step === 'ASK_AGE') {
      const age = parseInt(text, 10);
      if (!text || isNaN(age) || age <= 0 || age > 120) {
        await whatsapp.sendText(from, M.invalidAge);
        return;
      }
      await sheets.setPendingState(from, { step: 'ASK_REASON', name: state.name, age: String(age), reason: '', date: '', slot: '', lang: state.lang });
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
        await whatsapp.sendButtons(from, M.askDateRetry, M.dateButtons);
        return;
      }

      const sentToday = await sendSlotList(from, state, istDateString(offsetDays));

      if (!sentToday && offsetDays === 0) {
        // Today full -> try tomorrow automatically.
        const sentTomorrow = await sendSlotList(from, state, istDateString(1));
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
        const sent = await sendSlotList(from, state, state.date);
        if (!sent) {
          await whatsapp.sendText(from, M.noSlots);
          await sheets.clearPendingState(from);
        }
        return;
      }
      await movePatientToPaymentStep(from, { ...state, slot: buttonId }, settings);
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
          console.warn('No staff number configured (Settings tab / DOCTOR_WHATSAPP_NUMBER) - cannot forward screenshot.');
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

// ---------- Safety net for any route error ----------
app.use((err, req, res, next) => {
  console.error('Unhandled error on', req.method, req.path, ':', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong on the server. Check the Render logs.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp clinic bot listening on port ${PORT}`);

  // ---------- Auto-create/extend the Google Sheet structure ----------
  schema
    .ensureSheetSchema()
    .then((report) => {
      if (report.tabsCreated.length) console.log('[schema] Created new tabs:', report.tabsCreated.join(', '));
      if (Object.keys(report.columnsAdded).length) console.log('[schema] Added columns:', JSON.stringify(report.columnsAdded));
      if (report.settingsAdded.length) console.log('[schema] Added default Settings:', report.settingsAdded.join(', '));
    })
    .catch((err) => console.error('[schema] ensureSheetSchema failed:', err.message));

  // ---------- Automatic daily slot generation ----------
  function runSlotGeneration(trigger) {
    sheets
      .generateUpcomingSlots()
      .then((summary) => console.log(`[${trigger}] generateUpcomingSlots: added ${summary.added} new slot rows`))
      .catch((err) => {
        console.error(`[${trigger}] generateUpcomingSlots failed:`, err.message);
        alerts.sendAlert('slot-generation-failed', `Slot generation failed: ${err.message}`);
      });
  }
  // Short delay so the schema step can create the tabs first.
  setTimeout(() => runSlotGeneration('startup'), 5000);
  setInterval(() => runSlotGeneration('daily-timer'), 24 * 60 * 60 * 1000);

  // ---------- Self-ping keep-alive (Render free-tier workaround) ----------
  // Free web services sleep after ~15 min without an incoming request, which
  // also pauses the timer above. Pinging our own /ping every 10 minutes keeps
  // it awake. (Widely used workaround, not an official Render guarantee.)
  if (APP_BASE_URL) {
    setInterval(() => {
      axios.get(`${APP_BASE_URL}/ping`, { timeout: 10000 }).catch((err) => {
        console.warn('self-ping failed (non-fatal):', err.message);
      });
    }, 10 * 60 * 1000);
  } else {
    console.warn('APP_BASE_URL not set - self-ping keep-alive disabled (service may sleep on Render free tier).');
  }

  // Publish the Sheet link into the Settings tab too, so it is easy to copy.
  if (SHEET_LINK) {
    sheets
      .setSettingValue('Sheet Link', SHEET_LINK)
      .catch((err) => console.error('Could not write Sheet Link to Settings tab:', err.message));
  }
});
