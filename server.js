// server.js
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const { getMessages, LANGUAGE_BUTTONS, languagePrompt, SAME_PATIENT_BUTTONS } = require('./messages');

// New feature modules (added on top of the existing booking flow — see
// each file's header comment for what it owns).
const counters = require('./counters');
const patientsDomain = require('./patients');
const profileModule = require('./profile');
const queueModule = require('./queue');
const filesModule = require('./files');
const dashboardModule = require('./dashboard');
const casepaperModule = require('./casepaper');

const app = express();
app.use(express.json());
// Needed for the patient-profile page, which is a plain HTML <form method="POST">
// (no JS framework) — those submit as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: true }));

// Lightweight, unauthenticated health-check — used by our own self-ping
// below (Render free-tier keep-alive) and safe to hit from any uptime
// monitor too. Does not touch Google Sheets/Drive, so it never eats into
// API quota.
app.get('/ping', (req, res) => res.status(200).send('OK'));

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

// Decides how to greet an incoming patient:
// 1. If Settings has a "Default Language" forced, skip language selection
//    entirely and go straight to name (or the same-patient check below).
// 2. Else if we recognize this phone number (Patients tab), reuse their
//    saved language and ask "is this for you, or someone else?" instead of
//    re-collecting name/age.
// 3. Else (genuinely new number) show the branded English language picker.
async function startConversation(phone) {
  const settings = await sheets.getSettings();
  const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;
  const forcedLang = settings.defaultLanguage; // '' if not set in Settings

  const profile = await sheets.getPatientProfile(phone);
  console.log(`startConversation: phone=${phone} forcedLang="${forcedLang}" profile=${JSON.stringify(profile)}`);
  const lang = forcedLang || (profile && profile.lang) || '';

  if (profile && profile.name) {
    // Returning patient — skip language picker AND skip re-asking name/age
    // if it turns out to be the same person.
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
    // Brand-new number, but the clinic has hardcoded a single language —
    // skip the picker and go straight into the normal name/age flow.
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

  // Brand-new number, no forced language — show the branded picker.
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
  const feeNum = parseInt(fee, 10) || 0;

  // Fee set to 0 in Settings (typically Follow-up Fee) — skip payment
  // entirely. Staff still has to confirm, but based on the case-paper
  // validity instead of a payment screenshot.
  if (feeNum === 0) {
    await sheets.setPendingState(phone, {
      step: 'AWAITING_STAFF_CONFIRM',
      name: state.name,
      age: state.age,
      reason: state.reason,
      date: state.date,
      slot: state.slot,
      lang: state.lang,
    });
    await whatsapp.sendText(phone, M.freeAppointmentMessage(visitType));

    const staffNumber = settingsObj.staffNumber || (DOCTOR_NUMBER || '').replace(/\D/g, '');
    if (staffNumber) {
      const last4 = phone.slice(-4);
      const lastVisitDate = await sheets.getLastVisitDate(phone);
      const caseNote = lastVisitDate ? `📋 Last case paper: ${lastVisitDate} (still valid)\n` : '';
      await whatsapp.sendButtons(
        staffNumber,
        `🆓 *Free ${visitType} Booking*\n\n👤 ${state.name} (${state.age})\n🩺 ${state.reason || '-'}\n📅 ${state.date}  🕒 ${state.slot}\n${caseNote}📱 ...${last4}`,
        [
          { id: `confirm_${last4}`, title: '✅ Confirm' },
          { id: `hold_${last4}`, title: '⏳ Hold' },
        ]
      );
    } else {
      console.warn('No staff number configured — cannot notify staff about free booking.');
    }
    return;
  }

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
  const settings = await sheets.getSettings();
  const feeAmount =
    opts.paymentStatus === 'Free' ? 0 : parseInt(visitType === 'Follow-up' ? settings.followUpFee : settings.newPatientFee, 10) || 0;

  // --- New: Patient ID + Appointment (Booking) ID, generated once per booking ---
  const patientId = await patientsDomain.ensurePatientId(phone);
  const bookingId = await counters.nextAppointmentId();

  // Writes ALL columns (old + new) on one row, by header name — see
  // sheets.appendBookingRow(). If the live Sheet's Bookings tab hasn't had
  // the new columns added yet, those extra fields are simply skipped (the
  // original Timestamp..Visit Type columns are unaffected either way).
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
    'Visit Type': visitType,
    'Booking ID': bookingId,
    'Patient ID': patientId,
    'Case Paper Number': '', // generated lazily the first time the case paper page is opened
    Fee: feeAmount,
    'Booking Status': 'Confirmed',
    'Queue Status': 'Waiting',
    'Updated At': new Date().toISOString(),
  });

  await sheets.upsertPatientProfile(phone, { name, age, lang: opts.lang, lastVisitDate: dateStr });
  await patientsDomain.recordVisit(phone, dateStr);
  await sheets.clearPendingState(phone);

  // --- New: create today's live-queue entry for this token ---
  try {
    await queueModule.createQueueEntry({ dateStr, tokenNumber: token, bookingId, patientId });
  } catch (err) {
    console.error('createQueueEntry error (non-fatal):', err.message);
  }

  const M = getMessages(opts.lang);
  await whatsapp.sendText(
    phone,
    M.bookingConfirmed(opts.clinicName || CLINIC_NAME_FALLBACK, name, token, dateStr, slot)
  );

  // --- New: secure patient-profile completion link ---
  if (APP_BASE_URL) {
    try {
      const profileLink = await profileModule.createProfileLink(phone, APP_BASE_URL);
      await whatsapp.sendText(phone, M.profileLinkMessage(profileLink));
    } catch (err) {
      console.error('profile link error (non-fatal):', err.message);
    }
  }

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

  const settings = await sheets.getSettings();
  const visitType = await sheets.getVisitType(pending.phone);
  const fee = visitType === 'Follow-up' ? settings.followUpFee : settings.newPatientFee;
  const paymentStatus = (parseInt(fee, 10) || 0) === 0 ? 'Free' : 'Paid';

  await finalizeBooking(pending.phone, pending.name, pending.age, pending.reason, pending.date, pending.slot, token, {
    paymentStatus,
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
// MOVED to casepaper.js (upgraded: Case Paper Number, patient history panel,
// Save Diagnosis & Prescription). Same URL shape as before
// (/case-paper?secret=&phone=&date=&token=) so the WhatsApp link sent in
// finalizeBooking() above keeps working unchanged. escapeHtml() below is
// still used by buildDashboardHtml() further down, so it stays here.

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ---------- 2d. Staff/doctor dashboard — browse any day's patients from a PC ----------
// Unlike the one-off case-paper link sent via WhatsApp at booking time, this
// page can be opened anytime (bookmark it) and lets staff pick a date and
// jump straight into any patient's case paper.

function buildDashboardHtml({ clinicName, dateStr, bookings, secret }) {
  const total = bookings.length;
  const newCount = bookings.filter((b) => b['Visit Type'] === 'New').length;
  const followUpCount = bookings.filter((b) => b['Visit Type'] === 'Follow-up').length;
  const paidCount = bookings.filter((b) => b['Payment Status'] === 'Paid').length;
  const freeCount = bookings.filter((b) => b['Payment Status'] === 'Free').length;

  const rowsHtml = bookings.length
    ? bookings
        .map((b) => {
          const phone = String(b['Phone Number'] || '').replace(/^'/, '');
          const bookingDate = String(b['Date'] || '').replace(/^'/, '');
          const slot = String(b['Slot'] || '').replace(/^'/, '');
          const tokenVal = b['Token Number'];
          const link = `/case-paper?${new URLSearchParams({
            secret,
            phone,
            date: bookingDate,
            token: String(tokenVal),
          }).toString()}`;
          const visitType = b['Visit Type'] || '';
          const paymentStatus = b['Payment Status'] || '';
          return `
          <tr class="patient-row" data-name="${escapeHtml((b.Name || '').toLowerCase())}">
            <td class="center token-cell">${escapeHtml(tokenVal)}</td>
            <td class="name-cell">${escapeHtml(b.Name)}</td>
            <td class="center">${escapeHtml(b.Age)}</td>
            <td class="center">${escapeHtml(slot)}</td>
            <td class="reason-cell">${escapeHtml(b.Reason) || '-'}</td>
            <td class="center"><span class="badge ${visitType === 'New' ? 'new' : 'followup'}">${escapeHtml(visitType)}</span></td>
            <td class="center"><span class="paystatus ${paymentStatus === 'Free' ? 'free' : 'paid'}">${escapeHtml(paymentStatus)}</span></td>
            <td class="center"><a class="open-btn" href="${link}" target="_blank">📋 Open</a></td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="8" class="empty">No bookings for this date yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard - ${escapeHtml(clinicName)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
    margin: 0; padding: 32px 16px; color: #1f2b26; background: #eef2f0;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }

  .topbar { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 22px; flex-wrap: wrap; gap: 12px; }
  .topbar h1 { color: #14532d; font-size: 23px; margin: 0 0 4px; font-weight: 700; }
  .topbar .sub { color: #6b7d74; font-size: 13px; margin: 0; }

  .toolbar {
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    margin-bottom: 20px; background: #fff; padding: 14px 18px; border-radius: 12px;
    border: 1px solid #e0e9e4; box-shadow: 0 2px 10px rgba(15,60,45,0.04);
  }
  .toolbar form { display: flex; gap: 10px; align-items: center; }
  .toolbar input[type="date"] { padding: 7px 10px; border: 1px solid #cdd9d3; border-radius: 7px; font-size: 13.5px; }
  .toolbar button[type="submit"] { padding: 8px 18px; background: #14532d; color: #fff; border: none; border-radius: 7px; cursor: pointer; font-size: 13.5px; font-weight: 600; }
  .toolbar input[type="search"] { flex: 1; min-width: 160px; padding: 8px 12px; border: 1px solid #cdd9d3; border-radius: 7px; font-size: 13.5px; }

  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: #fff; border: 1px solid #e0e9e4; border-radius: 12px; padding: 14px 16px; box-shadow: 0 2px 10px rgba(15,60,45,0.04); }
  .stat-card .num { font-size: 22px; font-weight: 700; color: #14532d; }
  .stat-card .lbl { font-size: 11px; color: #7c8f85; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; font-weight: 600; }

  table { width: 100%; border-collapse: separate; border-spacing: 0; background: #fff; border-radius: 12px; overflow: hidden; border: 1px solid #e0e9e4; box-shadow: 0 2px 10px rgba(15,60,45,0.04); }
  th, td { border-bottom: 1px solid #eef2ef; padding: 11px 10px; font-size: 13.5px; text-align: left; }
  th { background: #14532d; color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #f7faf8; }
  td.center, th.center { text-align: center; }
  .name-cell { font-weight: 600; }
  .token-cell { font-weight: 700; color: #14532d; }
  .reason-cell { color: #556059; }
  .badge { display: inline-block; padding: 2px 11px; border-radius: 20px; font-size: 10.5px; font-weight: 700; }
  .badge.new { background: #fdecd4; color: #a15c00; }
  .badge.followup { background: #dcf1e6; color: #14532d; }
  .paystatus { font-size: 12px; font-weight: 600; }
  .paystatus.free { color: #b8862f; }
  .paystatus.paid { color: #14532d; }
  .open-btn { display: inline-block; padding: 6px 14px; background: #14532d; color: #fff !important; border-radius: 7px; text-decoration: none; font-size: 12.5px; font-weight: 600; }
  .open-btn:hover { background: #0f3f22; }
  .empty { text-align: center; color: #9aa8a1; padding: 30px; }
</style>
</head>
<body>
<div class="wrap">

  <div class="topbar">
    <div>
      <h1>${escapeHtml(clinicName)} — Patient Dashboard</h1>
      <p class="sub">Bookings for ${escapeHtml(dateStr)}. Bookmark this page for quick access anytime.</p>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <a href="/dashboard/home?secret=${encodeURIComponent(secret)}" style="font-size:12.5px;font-weight:600;color:#14532d;text-decoration:none;padding:7px 14px;border:1.5px solid #14532d;border-radius:7px;">🏠 Dashboard Home</a>
      <a href="/patients?secret=${encodeURIComponent(secret)}" style="font-size:12.5px;font-weight:600;color:#14532d;text-decoration:none;padding:7px 14px;border:1.5px solid #14532d;border-radius:7px;">🧑‍🤝‍🧑 Patients</a>
      <a href="/queue?secret=${encodeURIComponent(secret)}" style="font-size:12.5px;font-weight:600;color:#14532d;text-decoration:none;padding:7px 14px;border:1.5px solid #14532d;border-radius:7px;">⏱️ Live Queue</a>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="num">${total}</div><div class="lbl">Total</div></div>
    <div class="stat-card"><div class="num">${newCount}</div><div class="lbl">New</div></div>
    <div class="stat-card"><div class="num">${followUpCount}</div><div class="lbl">Follow-up</div></div>
    <div class="stat-card"><div class="num">${paidCount}</div><div class="lbl">Paid</div></div>
    <div class="stat-card"><div class="num">${freeCount}</div><div class="lbl">Free</div></div>
  </div>

  <div class="toolbar">
    <form method="get">
      <input type="hidden" name="secret" value="${escapeHtml(secret)}">
      <label>Date: <input type="date" name="date" value="${escapeHtml(dateStr)}"></label>
      <button type="submit">Load</button>
    </form>
    <input type="search" id="searchBox" placeholder="🔍 Search by patient name..." oninput="filterRows(this.value)">
  </div>

  <table>
    <thead>
      <tr>
        <th class="center">Token</th>
        <th>Name</th>
        <th class="center">Age</th>
        <th class="center">Time</th>
        <th>Reason</th>
        <th class="center">Visit Type</th>
        <th class="center">Payment</th>
        <th class="center">Case Paper</th>
      </tr>
    </thead>
    <tbody id="patientBody">
      ${rowsHtml}
    </tbody>
  </table>
</div>

<script>
  function filterRows(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('#patientBody tr.patient-row').forEach((row) => {
      row.style.display = row.dataset.name.includes(q) ? '' : 'none';
    });
  }
</script>
</body>
</html>`;
}

// Example: https://your-app.onrender.com/dashboard?secret=YOUR_SECRET
// Optional &date=YYYY-MM-DD (defaults to today).
app.get('/dashboard', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) {
    return res.sendStatus(401);
  }
  try {
    const settings = await sheets.getSettings();
    const dateStr = req.query.date || istDateString(0);
    const bookings = await sheets.getBookingsForDate(dateStr);

    const html = buildDashboardHtml({
      clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
      dateStr,
      bookings,
      secret: TRIGGER_SECRET,
    });

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('dashboard error:', err.message);
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

// ---------- 2e. New feature modules — routes ----------
// Each module owns its own routes; server.js just mounts them with the same
// shared secret used everywhere else (?secret=TRIGGER_SECRET).
const moduleCtx = { TRIGGER_SECRET, CLINIC_NAME_FALLBACK };
casepaperModule.registerRoutes(app, moduleCtx);
profileModule.registerRoutes(app, moduleCtx);
dashboardModule.registerRoutes(app, moduleCtx);
queueModule.registerRoutes(app, moduleCtx);
filesModule.registerRoutes(app, moduleCtx);

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
        // Skip straight to the reason — name/age are already known.
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
        // Someone else is using this WhatsApp number — collect a fresh
        // name/age, but keep the already-known language.
        await sheets.setPendingState(from, {
          step: 'ASK_NAME',
          name: '',
          age: '',
          reason: '',
          date: '',
          slot: '',
          lang: state.lang,
        });
        await whatsapp.sendText(from, M.welcomeAskName(clinicName));
        return;
      }
      // Didn't tap a button — re-ask.
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
      await sheets.setPendingState(from, {
        step: 'ASK_AGE',
        name: cleanedName,
        age: '',
        reason: '',
        date: '',
        slot: '',
        lang: state.lang,
      });
      await whatsapp.sendText(from, M.askAge(cleanedName));
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
app.listen(PORT, () => {
  console.log(`WhatsApp clinic bot listening on port ${PORT}`);

  // ---------- Automatic daily slot generation ----------
  // generateUpcomingSlots() was previously only reachable by manually
  // visiting /admin/generate-slots — if nobody opened that link on a given
  // day, the Capacity tab stopped growing and slots silently ran out.
  // Now it also runs once at startup and then every 24 hours for as long
  // as this process stays alive.
  //
  // CAVEAT (Render free tier): a free web service "sleeps" after ~15 min
  // with no incoming traffic, which pauses this timer too. To guarantee it
  // runs even while asleep, also set up an external ping once a day to
  // /admin/generate-slots?secret=YOUR_SECRET (Render's own Cron Jobs
  // feature, or a free service like cron-job.org / UptimeRobot) — that
  // request also wakes the service up, so the two approaches complement
  // each other rather than duplicating work (generateUpcomingSlots is
  // idempotent: re-running it never creates duplicate slot rows).
  function runSlotGeneration(trigger) {
    sheets
      .generateUpcomingSlots()
      .then((summary) =>
        console.log(`[${trigger}] generateUpcomingSlots: added ${summary.added} new slot rows (daysAhead=${summary.daysAhead}, slotsPerDay=${summary.slotsPerDay})`)
      )
      .catch((err) => console.error(`[${trigger}] generateUpcomingSlots failed:`, err.message));
  }
  runSlotGeneration('startup');
  setInterval(() => runSlotGeneration('daily-timer'), 24 * 60 * 60 * 1000);

  // ---------- Self-ping keep-alive (Render free-tier workaround) ----------
  // Render's free web services sleep after ~15 minutes with no INCOMING
  // request, which also pauses every setInterval above. Hitting our own
  // public /ping URL every 10 minutes is itself an incoming request from
  // Render's point of view, so it resets that idle timer — no external
  // cron service, no paid plan, nothing to sign up for.
  // Honest caveat: this is a widely-used workaround, not an official
  // Render guarantee — if Render's spin-down policy changes, this could
  // stop being effective. If you ever move to a paid Render plan (which
  // doesn't sleep), this block is harmless and simply becomes a no-op.
  if (APP_BASE_URL) {
    setInterval(() => {
      axios.get(`${APP_BASE_URL}/ping`, { timeout: 10000 }).catch((err) => {
        console.warn('self-ping failed (non-fatal):', err.message);
      });
    }, 10 * 60 * 1000);
  } else {
    console.warn('APP_BASE_URL not set — self-ping keep-alive disabled (service may sleep on Render free tier).');
  }

  if (APP_BASE_URL && TRIGGER_SECRET) {
    const dashboardLink = `${APP_BASE_URL}/dashboard?secret=${TRIGGER_SECRET}`;
    sheets
      .setSettingValue('Dashboard Link', dashboardLink)
      .then(() => console.log('Dashboard Link written to Settings tab:', dashboardLink))
      .catch((err) => console.error('Could not write Dashboard Link to Settings tab:', err.message));
  } else {
    console.warn('APP_BASE_URL or TRIGGER_SECRET not set — skipping Dashboard Link auto-publish.');
  }
});
