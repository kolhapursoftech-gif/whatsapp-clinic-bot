// server.js
require('dotenv').config();

const express = require('express');
const whatsapp = require('./whatsapp');
const sheets = require('./sheets');
const { getMessages, LANGUAGE_BUTTONS, languagePrompt, SAME_PATIENT_BUTTONS } = require('./messages');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  const patientId = await sheets.getOrCreatePatientId(phone);
  const bookingId = await sheets.generateAppointmentId();
  const casePaperNumber = await sheets.generateCasePaperNumber();

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
    bookingId,
    casePaperNumber,
    patientId,
  });
  await sheets.upsertPatientProfile(phone, { name, age, lang: opts.lang, lastVisitDate: dateStr, patientId });
  await sheets.clearPendingState(phone);

  const M = getMessages(opts.lang);
  await whatsapp.sendText(
    phone,
    M.bookingConfirmed(opts.clinicName || CLINIC_NAME_FALLBACK, name, token, dateStr, slot, patientId, bookingId)
  );

  if (APP_BASE_URL) {
    try {
      const profileToken = await sheets.issueProfileToken(phone);
      if (profileToken) {
        await whatsapp.sendText(phone, M.profileLinkMessage(`${APP_BASE_URL}/patient-profile/${profileToken}`));
      }
    } catch (err) {
      console.error('Could not issue/send profile link:', err.message);
    }
  }

  const notifyNumber = opts.staffNumber || DOCTOR_NUMBER;
  if (notifyNumber) {
    const casePaperLink = buildCasePaperLink({ phone, date: dateStr, token });
    await whatsapp.sendText(
      notifyNumber,
      `Naveen Booking: ${name} (${age}) - Token #${token} - ${dateStr} ${slot} - ${visitType} (Payment: ${opts.paymentStatus || 'Paid'})\nKaran: ${reason || '-'}\n🆔 ${patientId} | ${bookingId} | ${casePaperNumber}\n\n📋 Case Paper: ${casePaperLink}`
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

function buildCasePaperHtml({
  clinicName,
  clinicAddress,
  clinicPhone,
  doctorName,
  name,
  age,
  reason,
  date,
  slot,
  token,
  visitType,
  patientId,
  casePaperNumber,
  medicines = [],
}) {
  const rxRowTemplate = () => `
      <tr>
        <td class="num"></td>
        <td><input type="text" class="med-input" list="medlist" oninput="handleMedInput(this)" onchange="handleMedInput(this)" autocomplete="off" placeholder="Type to search medicine..."></td>
        <td contenteditable="true" class="center cell-morning"></td>
        <td contenteditable="true" class="center cell-evening"></td>
        <td contenteditable="true" class="center cell-before"></td>
        <td contenteditable="true" class="center cell-after"></td>
        <td contenteditable="true" class="center cell-days"></td>
      </tr>`;
  const rxRows = Array.from({ length: 4 }).map(rxRowTemplate).join('');

  const medicineOptions = medicines.map((m) => `<option value="${escapeHtml(m.name)}">`).join('');
  const medicineDbJson = JSON.stringify(
    medicines.reduce((acc, m) => {
      acc[m.name] = { morning: m.morning, evening: m.evening, beforeMeal: m.beforeMeal, afterMeal: m.afterMeal };
      return acc;
    }, {})
  );

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
  body {
    font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
    margin: 0; padding: 32px 16px; color: #1f2b26;
    background: #eef2f0;
  }
  .sheet {
    max-width: 840px; margin: 0 auto; background: #fff;
    border-radius: 14px; box-shadow: 0 4px 24px rgba(15, 60, 45, 0.08);
    padding: 40px 44px 32px;
  }

  .header { text-align: center; padding-bottom: 20px; margin-bottom: 26px; border-bottom: 3px solid #14532d; position: relative; }
  .header::after { content: ''; position: absolute; left: 50%; bottom: -3px; transform: translateX(-50%); width: 70px; height: 3px; background: #d4a94f; }
  .header h1 { margin: 0; color: #14532d; font-size: 27px; font-weight: 700; letter-spacing: 0.01em; }
  .header .contact { margin: 8px 0 0; color: #6b7d74; font-size: 12.5px; }
  .header .subtitle { margin: 12px 0 0; color: #b8862f; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; }

  .patient-info {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px 24px;
    background: #f7faf8; border: 1px solid #e0e9e4; border-radius: 12px;
    padding: 20px 24px; margin-bottom: 26px;
  }
  .patient-info .full { grid-column: 1 / -1; }
  .patient-info span.label { color: #7c8f85; display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3px; font-weight: 600; }
  .patient-info span.value { font-weight: 600; color: #1f2b26; font-size: 14.5px; }
  .badge { display: inline-block; padding: 3px 13px; border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.02em; }
  .badge.new { background: #fdecd4; color: #a15c00; }
  .badge.followup { background: #dcf1e6; color: #14532d; }

  h2.rx { font-size: 15.5px; color: #14532d; margin: 0 0 14px; text-transform: uppercase; letter-spacing: 0.06em; display: flex; align-items: center; gap: 8px; }
  h2.rx::before { content: '℞'; font-size: 22px; font-style: normal; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; border-radius: 10px; overflow: hidden; border: 1px solid #dbe5e0; }
  th, td { padding: 11px 9px; font-size: 13px; border-bottom: 1px solid #e5ece8; }
  th { background: #14532d; color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; text-align: left; }
  tbody tr:nth-child(even) { background: #fbfdfc; }
  tbody tr:last-child td { border-bottom: none; }
  td.num { text-align: center; color: #a7b5af; width: 28px; font-size: 12px; }
  td.center { text-align: center; }
  td[contenteditable="true"] { min-height: 26px; }
  td[contenteditable="true"]:focus { outline: 2px solid #14532d; background: #f3faf6; }
  .med-input { width: 100%; border: none; font-size: 13px; padding: 6px 4px; font-family: inherit; background: transparent; color: #1f2b26; }
  .med-input:focus { outline: 2px solid #14532d; background: #f3faf6; }
  .med-input::placeholder { color: #b6c2bc; }

  .signature-row { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 60px; padding: 0 6px; }
  .signature-block { text-align: center; width: 220px; }
  .signature-line { border-top: 1.5px solid #9aa8a1; margin-bottom: 8px; height: 36px; }
  .signature-block .label { font-size: 12px; color: #6b7d74; font-weight: 600; }

  .print-btn { display: block; margin: 32px auto 0; padding: 13px 32px; background: #14532d; color: #fff; border: none; border-radius: 9px; font-size: 15px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(20,83,45,0.25); }
  .print-btn:hover { background: #0f3f22; }
  .add-row-btn { display: block; margin: 12px 0 0; padding: 8px 16px; background: #fff; color: #14532d; border: 1.5px dashed #9aa8a1; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .add-row-btn:hover { border-color: #14532d; }

  @media print {
    .no-print { display: none !important; }
    body { padding: 0; background: #fff; }
    .sheet { box-shadow: none; border-radius: 0; padding: 0; max-width: 100%; }
  }
</style>
</head>
<body>
<div class="sheet">

  <div class="header">
    <h1>${escapeHtml(clinicName)}</h1>
    ${contactLine ? `<p class="contact">${escapeHtml(contactLine)}</p>` : ''}
    <p class="subtitle">Case Paper &amp; Prescription</p>
    ${casePaperNumber || patientId ? `<p class="contact">${[casePaperNumber, patientId ? `Patient ID: ${patientId}` : ''].filter(Boolean).map(escapeHtml).join('  •  ')}</p>` : ''}
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
    <div class="full"><span class="label">Reason for Visit</span><span class="value">${escapeHtml(reason) || '-'}</span></div>
  </div>

  <datalist id="medlist">${medicineOptions}</datalist>
  <script>
    const MEDICINE_DB = ${medicineDbJson};
    function tickIfSet(value) {
      return value && String(value).trim() ? '✓' : '';
    }
    function handleMedInput(input) {
      const med = MEDICINE_DB[input.value];
      if (!med) return; // not an exact match yet — wait for a real selection
      const row = input.closest('tr');
      row.querySelector('.cell-morning').textContent = tickIfSet(med.morning);
      row.querySelector('.cell-evening').textContent = tickIfSet(med.evening);
      row.querySelector('.cell-before').textContent = tickIfSet(med.beforeMeal);
      row.querySelector('.cell-after').textContent = tickIfSet(med.afterMeal);
      // "Days" is left untouched — doctor fills that in manually per patient.
    }

    let rxRowCount = ${4};
    function addRxRow() {
      rxRowCount++;
      const tbody = document.getElementById('rxBody');
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td class="num"></td>
        <td><input type="text" class="med-input" list="medlist" oninput="handleMedInput(this)" onchange="handleMedInput(this)" autocomplete="off" placeholder="Type to search medicine..."></td>
        <td contenteditable="true" class="center cell-morning"></td>
        <td contenteditable="true" class="center cell-evening"></td>
        <td contenteditable="true" class="center cell-before"></td>
        <td contenteditable="true" class="center cell-after"></td>
        <td contenteditable="true" class="center cell-days"></td>
      \`;
      tbody.appendChild(tr);
    }
  </script>

  <h2 class="rx">Prescription</h2>
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
    <tbody id="rxBody">
      ${rxRows}
    </tbody>
  </table>

  <button class="add-row-btn no-print" onclick="addRxRow()">+ Add Medicine Row</button>

  <div class="signature-row">
    <div class="signature-block">
      <div class="signature-line"></div>
      <div class="label">Date</div>
    </div>
    <div class="signature-block">
      <div class="signature-line"></div>
      <div class="label">${doctorName ? escapeHtml(doctorName) : "Doctor's Signature"}</div>
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
    const medicines = await sheets.getMedicineDatabase();

    const html = buildCasePaperHtml({
      clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
      clinicAddress: settings.clinicAddress,
      clinicPhone: settings.clinicPhone,
      doctorName: settings.doctorName,
      name: booking.Name,
      age: booking.Age,
      reason: booking.Reason,
      date: booking.Date,
      slot: booking.Slot,
      token: booking['Token Number'],
      visitType: booking['Visit Type'],
      patientId: booking['Patient ID'],
      casePaperNumber: booking['Case Paper Number'],
      medicines,
    });

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('case-paper error:', err.message);
    res.status(500).send('Error loading case paper: ' + err.message);
  }
});

// ---------- 2d. Staff/doctor dashboard — full hospital-style admin panel ----------
// One page, several tabs (all client-rendered from the JSON API endpoints
// below): Today's Queue, Calendar, Patients, Payments, Capacity, Medicines.
// Bookmark it once — the secret stays in the URL/localStorage so staff never
// have to retype it.

function requireSecret(req, res) {
  const secret = req.query.secret || (req.body && req.body.secret);
  if (secret !== TRIGGER_SECRET) {
    res.status(401).json({ error: 'Invalid or missing secret' });
    return false;
  }
  return true;
}

function feeForVisitType(settings, visitType) {
  const raw =
    visitType === 'New' ? settings.newPatientFee : visitType === 'Follow-up' ? settings.followUpFee : settings.feeAmount;
  const n = parseFloat(raw);
  return isNaN(n) ? 0 : n;
}

// ---- Read-only JSON APIs ----

app.get('/api/bookings-range', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const start = req.query.start || istDateString(0);
    const end = req.query.end || start;
    const [bookings, settings] = await Promise.all([sheets.getBookingsInRange(start, end), sheets.getSettings()]);

    let revenue = 0;
    let paidCount = 0;
    let freeCount = 0;
    const byDate = {};
    bookings.forEach((b) => {
      const d = b.Date;
      byDate[d] = byDate[d] || { date: d, total: 0, new: 0, followUp: 0, revenue: 0 };
      byDate[d].total += 1;
      if (b['Visit Type'] === 'New') byDate[d].new += 1;
      if (b['Visit Type'] === 'Follow-up') byDate[d].followUp += 1;
      if (b['Payment Status'] === 'Paid') {
        paidCount += 1;
        const fee = feeForVisitType(settings, b['Visit Type']);
        revenue += fee;
        byDate[d].revenue += fee;
      } else if (b['Payment Status'] === 'Free') {
        freeCount += 1;
      }
    });

    res.json({
      start,
      end,
      bookings,
      summary: {
        total: bookings.length,
        paidCount,
        freeCount,
        revenue,
        newCount: bookings.filter((b) => b['Visit Type'] === 'New').length,
        followUpCount: bookings.filter((b) => b['Visit Type'] === 'Follow-up').length,
        byDate: Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1)),
      },
    });
  } catch (err) {
    console.error('api/bookings-range error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patients', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    let patients = await sheets.getAllPatients();
    if (q) {
      patients = patients.filter(
        (p) => p.name.toLowerCase().includes(q) || p.phone.includes(q) || p.patientId.toLowerCase().includes(q)
      );
    }
    patients.sort((a, b) => (a.lastVisitDate < b.lastVisitDate ? 1 : -1));
    res.json({ patients });
  } catch (err) {
    console.error('api/patients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patient-history', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const phone = (req.query.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    const [profile, bookings] = await Promise.all([sheets.getPatientProfile(phone), sheets.getBookingsForPhone(phone)]);
    res.json({ profile, bookings });
  } catch (err) {
    console.error('api/patient-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/capacity', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const dateStr = req.query.date || istDateString(0);
    const slots = await sheets.getCapacityForDate(dateStr);
    res.json({ date: dateStr, slots });
  } catch (err) {
    console.error('api/capacity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/capacity/update', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const rowNumber = parseInt(req.body.rowNumber, 10);
    const maxCapacity = parseInt(req.body.maxCapacity, 10);
    if (!rowNumber || isNaN(maxCapacity) || maxCapacity < 0) {
      return res.status(400).json({ error: 'rowNumber and a valid maxCapacity are required' });
    }
    await sheets.updateCapacitySlotByRow(rowNumber, maxCapacity);
    res.json({ ok: true });
  } catch (err) {
    console.error('api/capacity/update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/medicines', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const medicines = await sheets.getMedicineDatabase();
    res.json({ medicines });
  } catch (err) {
    console.error('api/medicines error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Walk-in booking (staff adds a patient directly from the dashboard,
// no WhatsApp conversation needed) — reuses the exact same finalizeBooking
// path as the bot, so numbering, Patients tab, and the staff WhatsApp
// notification all stay consistent with normal bookings. ----

app.post('/api/walkin', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const phone = (req.body.phone || '').replace(/\D/g, '');
    const name = (req.body.name || '').trim();
    const age = (req.body.age || '').trim();
    const reason = (req.body.reason || '').trim();
    const date = (req.body.date || istDateString(0)).trim();
    const slot = (req.body.slot || '').trim();
    const paymentStatus = req.body.paymentStatus === 'Free' ? 'Free' : 'Paid';

    if (!phone || phone.length < 10) return res.status(400).json({ error: 'A valid phone number is required' });
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!slot) return res.status(400).json({ error: 'Slot is required' });

    const token = await sheets.getNextAvailableTokenForSlot(date, slot);
    if (!token) return res.status(409).json({ error: 'That slot is full or does not exist — pick another.' });

    const settings = await sheets.getSettings();
    await finalizeBooking(phone, name, age, reason, date, slot, token, {
      paymentStatus,
      clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
      staffNumber: settings.staffNumber || DOCTOR_NUMBER,
      lang: settings.defaultLanguage || 'en',
    });

    res.json({ ok: true, token, date, slot });
  } catch (err) {
    console.error('api/walkin error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- CSV export ----

app.get('/dashboard/export.csv', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) return res.sendStatus(401);
  try {
    const start = req.query.start || istDateString(0);
    const end = req.query.end || start;
    const bookings = await sheets.getBookingsInRange(start, end);

    const cols = ['Date', 'Slot', 'Token Number', 'Name', 'Age', 'Phone Number', 'Reason', 'Visit Type', 'Payment Status'];
    const csvEscape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [cols.join(',')];
    bookings.forEach((b) => lines.push(cols.map((c) => csvEscape(b[c])).join(',')));

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="bookings_${start}_to_${end}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('export.csv error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

// ---- The dashboard app shell itself ----

function buildDashboardAppHtml({ clinicName, secret, todayStr }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard - ${escapeHtml(clinicName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; margin: 0; padding: 20px 16px 60px; color: #1f2b26; background: #eef2f0; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { color: #14532d; font-size: 21px; margin: 0 0 2px; font-weight: 700; }
  .sub { color: #6b7d74; font-size: 12.5px; margin: 0 0 16px; }

  .tabs { display: flex; gap: 4px; margin-bottom: 18px; flex-wrap: wrap; background: #fff; padding: 5px; border-radius: 12px; border: 1px solid #e0e9e4; }
  .tab-btn { padding: 9px 16px; border: none; background: transparent; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; color: #4d5e56; }
  .tab-btn.active { background: #14532d; color: #fff; }

  .card { background: #fff; border: 1px solid #e0e9e4; border-radius: 12px; padding: 16px 18px; box-shadow: 0 2px 10px rgba(15,60,45,0.04); margin-bottom: 16px; }
  .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  input, select { padding: 7px 10px; border: 1px solid #cdd9d3; border-radius: 7px; font-size: 13px; }
  input[type="search"] { flex: 1; min-width: 160px; }
  button.primary { padding: 8px 16px; background: #14532d; color: #fff; border: none; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 600; }
  button.primary:hover { background: #0f3f22; }
  button.secondary { padding: 8px 16px; background: #eef2f0; color: #14532d; border: 1px solid #cdd9d3; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 600; }
  a.btn-link { display: inline-block; padding: 7px 14px; background: #14532d; color: #fff !important; border-radius: 7px; text-decoration: none; font-size: 12.5px; font-weight: 600; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .stat-card { background: #fff; border: 1px solid #e0e9e4; border-radius: 12px; padding: 12px 14px; box-shadow: 0 2px 10px rgba(15,60,45,0.04); }
  .stat-card .num { font-size: 20px; font-weight: 700; color: #14532d; }
  .stat-card .lbl { font-size: 10.5px; color: #7c8f85; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; font-weight: 600; }

  table { width: 100%; border-collapse: separate; border-spacing: 0; background: #fff; border-radius: 12px; overflow: hidden; border: 1px solid #e0e9e4; }
  th, td { border-bottom: 1px solid #eef2ef; padding: 10px; font-size: 13px; text-align: left; }
  th { background: #14532d; color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #f7faf8; }
  td.center, th.center { text-align: center; }
  .badge { display: inline-block; padding: 2px 11px; border-radius: 20px; font-size: 10.5px; font-weight: 700; }
  .badge.new { background: #fdecd4; color: #a15c00; }
  .badge.followup { background: #dcf1e6; color: #14532d; }
  .paystatus { font-size: 12px; font-weight: 600; }
  .paystatus.free { color: #b8862f; }
  .paystatus.paid { color: #14532d; }
  .empty { text-align: center; color: #9aa8a1; padding: 30px; }
  .clickable-row { cursor: pointer; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(15,30,20,0.45); align-items: center; justify-content: center; z-index: 50; padding: 16px; }
  .modal-overlay.open { display: flex; }
  .modal-box { background: #fff; border-radius: 14px; padding: 22px; max-width: 480px; width: 100%; max-height: 85vh; overflow-y: auto; }
  .modal-box h2 { margin: 0 0 14px; font-size: 17px; color: #14532d; }
  .field { margin-bottom: 12px; display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 12px; font-weight: 600; color: #4d5e56; }
  .field input, .field select { width: 100%; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
  .close-x { float: right; cursor: pointer; font-size: 20px; color: #9aa8a1; line-height: 1; }
  .chart-wrap { overflow-x: auto; }
  .msg { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
  .msg.err { background: #fdecec; color: #a11616; }
  .msg.ok { background: #dcf1e6; color: #14532d; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(clinicName)} — Dashboard</h1>
  <p class="sub">Full patient &amp; clinic management. Bookmark this page.</p>

  <div class="tabs" id="tabs">
    <button class="tab-btn" data-tab="today">Today's Queue</button>
    <button class="tab-btn" data-tab="calendar">Calendar</button>
    <button class="tab-btn" data-tab="patients">Patients</button>
    <button class="tab-btn" data-tab="payments">Payments</button>
    <button class="tab-btn" data-tab="capacity">Capacity</button>
    <button class="tab-btn" data-tab="medicines">Medicines</button>
  </div>

  <div id="content"></div>
</div>

<div class="modal-overlay" id="walkinModal">
  <div class="modal-box">
    <span class="close-x" onclick="closeWalkinModal()">&times;</span>
    <h2>Add Walk-in Patient</h2>
    <div id="walkinMsg"></div>
    <div class="field"><label>Name</label><input id="wName" placeholder="Patient name"></div>
    <div class="field"><label>Phone (10 digit)</label><input id="wPhone" placeholder="9876543210"></div>
    <div class="field"><label>Age</label><input id="wAge" placeholder="Age"></div>
    <div class="field"><label>Reason (optional)</label><input id="wReason" placeholder="Reason for visit"></div>
    <div class="field"><label>Date</label><input id="wDate" type="date"></div>
    <div class="field"><label>Slot</label><select id="wSlot"><option value="">Pick a date first</option></select></div>
    <div class="field"><label>Payment</label><select id="wPayment"><option value="Paid">Paid</option><option value="Free">Free</option></select></div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeWalkinModal()">Cancel</button>
      <button class="primary" onclick="submitWalkin()">Add Booking</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="historyModal">
  <div class="modal-box">
    <span class="close-x" onclick="document.getElementById('historyModal').classList.remove('open')">&times;</span>
    <h2 id="historyTitle">Patient History</h2>
    <div id="historyBody"></div>
  </div>
</div>

<script>
const SECRET = ${JSON.stringify(secret)};
const TODAY = ${JSON.stringify(todayStr)};
let currentTab = 'today';

function api(path, opts) {
  const url = new URL(path, window.location.origin);
  if (!opts || opts.method === undefined || opts.method === 'GET') {
    url.searchParams.set('secret', SECRET);
    return fetch(url).then((r) => r.json());
  }
  return fetch(url, {
    method: opts.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...opts.body, secret: SECRET }),
  }).then((r) => r.json());
}

function esc(s) { const d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const renderers = { today: renderToday, calendar: renderCalendar, patients: renderPatients, payments: renderPayments, capacity: renderCapacity, medicines: renderMedicines };
  renderers[tab]();
}

// ---------- Today's Queue ----------
async function renderToday(dateStr) {
  dateStr = dateStr || TODAY;
  const content = document.getElementById('content');
  content.innerHTML = '<div class="card">Loading…</div>';
  const data = await api('/api/bookings-range?start=' + dateStr + '&end=' + dateStr);
  const s = data.summary;
  const rows = data.bookings;
  content.innerHTML = \`
    <div class="card">
      <div class="toolbar">
        <label>Date: <input type="date" id="todayDate" value="\${dateStr}" onchange="renderToday(this.value)"></label>
        <button class="primary" onclick="openWalkinModal('\${dateStr}')">+ Add Walk-in</button>
        <a class="btn-link" href="/dashboard/export.csv?secret=\${encodeURIComponent(SECRET)}&start=\${dateStr}&end=\${dateStr}" target="_blank">⬇ Export CSV</a>
        <input type="search" id="searchBox" placeholder="🔍 Search by name..." oninput="filterTodayRows(this.value)" style="margin-left:auto;">
      </div>
      <div class="stats">
        <div class="stat-card"><div class="num">\${s.total}</div><div class="lbl">Total</div></div>
        <div class="stat-card"><div class="num">\${s.newCount}</div><div class="lbl">New</div></div>
        <div class="stat-card"><div class="num">\${s.followUpCount}</div><div class="lbl">Follow-up</div></div>
        <div class="stat-card"><div class="num">\${s.paidCount}</div><div class="lbl">Paid</div></div>
        <div class="stat-card"><div class="num">\${s.freeCount}</div><div class="lbl">Free</div></div>
        <div class="stat-card"><div class="num">₹\${s.revenue}</div><div class="lbl">Revenue</div></div>
      </div>
      <table>
        <thead><tr><th class="center">Token</th><th>Name</th><th class="center">Age</th><th class="center">Time</th><th>Reason</th><th class="center">Type</th><th class="center">Payment</th><th class="center">Case Paper</th></tr></thead>
        <tbody id="todayBody">
          \${rows.length ? rows.map((b) => \`
            <tr class="patient-row" data-name="\${esc((b.Name||'').toLowerCase())}">
              <td class="center" style="font-weight:700;color:#14532d;">\${esc(b['Token Number'])}</td>
              <td style="font-weight:600;">\${esc(b.Name)}</td>
              <td class="center">\${esc(b.Age)}</td>
              <td class="center">\${esc(b.Slot)}</td>
              <td>\${esc(b.Reason) || '-'}</td>
              <td class="center"><span class="badge \${b['Visit Type']==='New'?'new':'followup'}">\${esc(b['Visit Type'])}</span></td>
              <td class="center"><span class="paystatus \${b['Payment Status']==='Free'?'free':'paid'}">\${esc(b['Payment Status'])}</span></td>
              <td class="center"><a class="btn-link" target="_blank" href="/case-paper?secret=\${encodeURIComponent(SECRET)}&phone=\${esc(b['Phone Number'])}&date=\${dateStr}&token=\${esc(b['Token Number'])}">📋 Open</a></td>
            </tr>\`).join('') : '<tr><td colspan="8" class="empty">No bookings for this date yet.</td></tr>'}
        </tbody>
      </table>
    </div>\`;
}
function filterTodayRows(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#todayBody tr.patient-row').forEach((row) => { row.style.display = row.dataset.name.includes(q) ? '' : 'none'; });
}

// ---------- Calendar (last 7 + next 7 days) ----------
async function renderCalendar() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="card">Loading…</div>';
  const start = shiftDate(TODAY, -6);
  const end = shiftDate(TODAY, 7);
  const data = await api('/api/bookings-range?start=' + start + '&end=' + end);
  const byDate = {};
  data.summary.byDate.forEach((d) => { byDate[d.date] = d; });
  const days = [];
  for (let i = -6; i <= 7; i++) days.push(shiftDate(TODAY, i));
  const max = Math.max(1, ...days.map((d) => (byDate[d] ? byDate[d].total : 0)));

  content.innerHTML = \`
    <div class="card">
      <h2 style="margin-top:0;font-size:15px;color:#14532d;">Bookings — last 7 & next 7 days</h2>
      <div class="chart-wrap">
        <div style="display:flex;gap:8px;align-items:flex-end;min-width:700px;height:140px;padding-top:10px;">
          \${days.map((d) => {
            const count = byDate[d] ? byDate[d].total : 0;
            const h = Math.round((count / max) * 100);
            const isToday = d === TODAY;
            return \`<div style="flex:1;text-align:center;cursor:pointer;" onclick="switchTab('today'); setTimeout(()=>renderToday('\${d}'),0);" title="\${d}: \${count} bookings">
              <div style="height:100px;display:flex;align-items:flex-end;justify-content:center;">
                <div style="width:70%;background:\${isToday?'#14532d':'#8fbfa0'};border-radius:4px 4px 0 0;height:\${Math.max(h,3)}%;"></div>
              </div>
              <div style="font-size:10px;color:#7c8f85;margin-top:4px;">\${d.slice(5)}</div>
              <div style="font-size:11px;font-weight:700;color:#14532d;">\${count}</div>
            </div>\`;
          }).join('')}
        </div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;font-size:15px;color:#14532d;">Pick any date</h2>
      <div class="toolbar">
        <input type="date" id="calDate" value="\${TODAY}">
        <button class="primary" onclick="switchTab('today'); setTimeout(()=>renderToday(document.getElementById('calDate').value),0);">Open that day's queue</button>
      </div>
    </div>\`;
}
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Patients ----------
async function renderPatients(q) {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="card">Loading…</div>';
  const data = await api('/api/patients' + (q ? '?q=' + encodeURIComponent(q) : ''));
  content.innerHTML = \`
    <div class="card">
      <div class="toolbar">
        <input type="search" placeholder="🔍 Search by name, phone, or patient ID..." style="flex:1;" oninput="renderPatients(this.value)" value="\${esc(q||'')}">
      </div>
      <table>
        <thead><tr><th>Name</th><th class="center">Age</th><th>Phone</th><th>Patient ID</th><th class="center">Last Visit</th><th class="center">History</th></tr></thead>
        <tbody>
          \${data.patients.length ? data.patients.map((p) => \`
            <tr>
              <td style="font-weight:600;">\${esc(p.name)}</td>
              <td class="center">\${esc(p.age)}</td>
              <td>\${esc(p.phone)}</td>
              <td>\${esc(p.patientId)}</td>
              <td class="center">\${esc(p.lastVisitDate) || '-'}</td>
              <td class="center"><button class="secondary" onclick="openHistory('\${esc(p.phone)}','\${esc(p.name)}')">View</button></td>
            </tr>\`).join('') : '<tr><td colspan="6" class="empty">No patients found.</td></tr>'}
        </tbody>
      </table>
    </div>\`;
}

async function openHistory(phone, name) {
  document.getElementById('historyTitle').textContent = name + "'s History";
  document.getElementById('historyBody').innerHTML = 'Loading…';
  document.getElementById('historyModal').classList.add('open');
  const data = await api('/api/patient-history?phone=' + encodeURIComponent(phone));
  const rows = data.bookings || [];
  document.getElementById('historyBody').innerHTML = rows.length ? \`
    <table><thead><tr><th>Date</th><th>Time</th><th class="center">Type</th><th class="center">Payment</th><th class="center">Open</th></tr></thead>
    <tbody>\${rows.map((b) => \`<tr>
      <td>\${esc(b.Date)}</td><td>\${esc(b.Slot)}</td>
      <td class="center"><span class="badge \${b['Visit Type']==='New'?'new':'followup'}">\${esc(b['Visit Type'])}</span></td>
      <td class="center"><span class="paystatus \${b['Payment Status']==='Free'?'free':'paid'}">\${esc(b['Payment Status'])}</span></td>
      <td class="center"><a class="btn-link" target="_blank" href="/case-paper?secret=\${encodeURIComponent(SECRET)}&phone=\${encodeURIComponent(phone)}&date=\${b.Date}&token=\${esc(b['Token Number'])}">📋</a></td>
    </tr>\`).join('')}</tbody></table>\` : '<p class="empty">No bookings on record.</p>';
}

// ---------- Payments / Revenue ----------
async function renderPayments(start, end) {
  start = start || shiftDate(TODAY, -29);
  end = end || TODAY;
  const content = document.getElementById('content');
  content.innerHTML = '<div class="card">Loading…</div>';
  const data = await api('/api/bookings-range?start=' + start + '&end=' + end);
  const s = data.summary;
  const max = Math.max(1, ...s.byDate.map((d) => d.revenue));
  content.innerHTML = \`
    <div class="card">
      <div class="toolbar">
        <label>From <input type="date" id="payStart" value="\${start}"></label>
        <label>To <input type="date" id="payEnd" value="\${end}"></label>
        <button class="primary" onclick="renderPayments(document.getElementById('payStart').value, document.getElementById('payEnd').value)">Load</button>
        <a class="btn-link" href="/dashboard/export.csv?secret=\${encodeURIComponent(SECRET)}&start=\${start}&end=\${end}" target="_blank">⬇ Export CSV</a>
      </div>
      <div class="stats">
        <div class="stat-card"><div class="num">₹\${s.revenue}</div><div class="lbl">Total Revenue</div></div>
        <div class="stat-card"><div class="num">\${s.paidCount}</div><div class="lbl">Paid Visits</div></div>
        <div class="stat-card"><div class="num">\${s.freeCount}</div><div class="lbl">Free Visits</div></div>
        <div class="stat-card"><div class="num">\${s.total}</div><div class="lbl">Total Visits</div></div>
      </div>
      <div class="chart-wrap">
        <div style="display:flex;gap:6px;align-items:flex-end;min-width:\${Math.max(700, s.byDate.length*36)}px;height:140px;padding-top:10px;">
          \${s.byDate.map((d) => \`<div style="flex:1;text-align:center;" title="\${d.date}: ₹\${d.revenue}">
            <div style="height:100px;display:flex;align-items:flex-end;justify-content:center;">
              <div style="width:70%;background:#14532d;border-radius:4px 4px 0 0;height:\${Math.max(Math.round((d.revenue/max)*100),3)}%;"></div>
            </div>
            <div style="font-size:9.5px;color:#7c8f85;margin-top:4px;">\${d.date.slice(5)}</div>
          </div>\`).join('')}
        </div>
      </div>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th class="center">Total</th><th class="center">New</th><th class="center">Follow-up</th><th class="center">Revenue</th></tr></thead>
        <tbody>\${s.byDate.length ? s.byDate.map((d) => \`<tr><td>\${d.date}</td><td class="center">\${d.total}</td><td class="center">\${d.new}</td><td class="center">\${d.followUp}</td><td class="center">₹\${d.revenue}</td></tr>\`).join('') : '<tr><td colspan="5" class="empty">No data in this range.</td></tr>'}</tbody>
      </table>
    </div>\`;
}

// ---------- Capacity ----------
async function renderCapacity(dateStr) {
  dateStr = dateStr || TODAY;
  const content = document.getElementById('content');
  content.innerHTML = '<div class="card">Loading…</div>';
  const data = await api('/api/capacity?date=' + dateStr);
  content.innerHTML = \`
    <div class="card">
      <div class="toolbar">
        <label>Date: <input type="date" id="capDate" value="\${dateStr}" onchange="renderCapacity(this.value)"></label>
        <a class="btn-link" href="/admin/generate-slots?secret=\${encodeURIComponent(SECRET)}" target="_blank">⚡ Generate upcoming slots</a>
      </div>
      <div id="capMsg"></div>
      <table>
        <thead><tr><th>Slot</th><th class="center">Booked</th><th class="center">Max Capacity</th><th class="center">Save</th></tr></thead>
        <tbody>
          \${data.slots.length ? data.slots.map((s) => \`
            <tr>
              <td>\${esc(s.slot)}</td>
              <td class="center">\${s.booked}</td>
              <td class="center"><input type="number" min="0" style="width:70px;text-align:center;" id="cap-\${s.rowNumber}" value="\${s.maxCapacity}"></td>
              <td class="center"><button class="secondary" onclick="saveCapacity(\${s.rowNumber})">Save</button></td>
            </tr>\`).join('') : '<tr><td colspan="4" class="empty">No slots generated for this date yet — click "Generate upcoming slots" above.</td></tr>'}
        </tbody>
      </table>
    </div>\`;
}
async function saveCapacity(rowNumber) {
  const val = document.getElementById('cap-' + rowNumber).value;
  const res = await api('/api/capacity/update', { method: 'POST', body: { rowNumber, maxCapacity: val } });
  document.getElementById('capMsg').innerHTML = res.ok ? '<div class="msg ok">Saved.</div>' : '<div class="msg err">' + esc(res.error||'Save failed') + '</div>';
}

// ---------- Medicines ----------
async function renderMedicines() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="card">Loading…</div>';
  const data = await api('/api/medicines');
  content.innerHTML = \`
    <div class="card">
      <div class="toolbar"><input type="search" id="medSearch" placeholder="🔍 Search medicine..." oninput="filterMeds(this.value)"></div>
      <table>
        <thead><tr><th>Medicine</th><th class="center">Morning</th><th class="center">Evening</th><th class="center">Before Meal</th><th class="center">After Meal</th></tr></thead>
        <tbody id="medBody">
          \${data.medicines.length ? data.medicines.map((m) => \`
            <tr class="med-row" data-name="\${esc(m.name.toLowerCase())}">
              <td style="font-weight:600;">\${esc(m.name)}</td>
              <td class="center">\${esc(m.morning)}</td>
              <td class="center">\${esc(m.evening)}</td>
              <td class="center">\${esc(m.beforeMeal)}</td>
              <td class="center">\${esc(m.afterMeal)}</td>
            </tr>\`).join('') : '<tr><td colspan="5" class="empty">No medicines in the database yet.</td></tr>'}
        </tbody>
      </table>
    </div>\`;
}
function filterMeds(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#medBody tr.med-row').forEach((row) => { row.style.display = row.dataset.name.includes(q) ? '' : 'none'; });
}

// ---------- Walk-in modal ----------
function openWalkinModal(dateStr) {
  document.getElementById('walkinMsg').innerHTML = '';
  document.getElementById('wName').value = '';
  document.getElementById('wPhone').value = '';
  document.getElementById('wAge').value = '';
  document.getElementById('wReason').value = '';
  document.getElementById('wDate').value = dateStr || TODAY;
  document.getElementById('wPayment').value = 'Paid';
  loadSlotsForWalkin(dateStr || TODAY);
  document.getElementById('wDate').onchange = (e) => loadSlotsForWalkin(e.target.value);
  document.getElementById('walkinModal').classList.add('open');
}
function closeWalkinModal() { document.getElementById('walkinModal').classList.remove('open'); }
async function loadSlotsForWalkin(dateStr) {
  const sel = document.getElementById('wSlot');
  sel.innerHTML = '<option>Loading…</option>';
  const data = await api('/api/capacity?date=' + dateStr);
  const open = data.slots.filter((s) => s.booked < s.maxCapacity);
  sel.innerHTML = open.length
    ? open.map((s) => \`<option value="\${esc(s.slot)}">\${esc(s.slot)} (\${s.maxCapacity - s.booked} open)</option>\`).join('')
    : '<option value="">No open slots this date</option>';
}
async function submitWalkin() {
  const body = {
    name: document.getElementById('wName').value.trim(),
    phone: document.getElementById('wPhone').value.trim(),
    age: document.getElementById('wAge').value.trim(),
    reason: document.getElementById('wReason').value.trim(),
    date: document.getElementById('wDate').value,
    slot: document.getElementById('wSlot').value,
    paymentStatus: document.getElementById('wPayment').value,
  };
  const res = await api('/api/walkin', { method: 'POST', body });
  if (res.ok) {
    document.getElementById('walkinMsg').innerHTML = '<div class="msg ok">Booked — Token #' + res.token + '</div>';
    setTimeout(() => { closeWalkinModal(); renderToday(body.date); }, 900);
  } else {
    document.getElementById('walkinMsg').innerHTML = '<div class="msg err">' + esc(res.error || 'Failed') + '</div>';
  }
}

switchTab('today');
</script>
</body>
</html>`;
}

// Example: https://your-app.onrender.com/dashboard?secret=YOUR_SECRET
app.get('/dashboard', async (req, res) => {
  if (req.query.secret !== TRIGGER_SECRET) {
    return res.sendStatus(401);
  }
  try {
    const settings = await sheets.getSettings();
    const html = buildDashboardAppHtml({
      clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
      secret: TRIGGER_SECRET,
      todayStr: istDateString(0),
    });
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('dashboard error:', err.message);
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

// ---------- 2e. Patient profile page (secure token link, Phase 3) ----------

function buildPatientProfileFormHtml({ clinicName, patient, token }) {
  const val = (key) => escapeHtml(patient[key] || '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Patient Profile - ${escapeHtml(clinicName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 24px 16px; background: #eef2f0; color: #1f2b26; }
  .card { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(15,60,45,0.08); padding: 32px; }
  h1 { color: #14532d; font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #6b7d74; font-size: 13px; margin: 0 0 22px; }
  label { display: block; font-size: 12.5px; font-weight: 600; color: #3f5148; margin: 14px 0 5px; }
  input, select, textarea { width: 100%; padding: 9px 11px; border: 1px solid #cdd9d3; border-radius: 8px; font-size: 14px; font-family: inherit; }
  textarea { resize: vertical; min-height: 60px; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
  button { margin-top: 22px; width: 100%; padding: 12px; background: #14532d; color: #fff; border: none; border-radius: 9px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #0f3f22; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(clinicName)} — Patient Profile</h1>
    <p class="sub">Hi ${val('Name')}, please fill in a few extra details so the clinic has your complete profile.</p>
    <form method="POST" action="/patient-profile/${escapeHtml(token)}">
      <div class="row2">
        <div><label>Date of Birth</label><input type="date" name="dob" value="${val('DOB')}"></div>
        <div><label>Gender</label>
          <select name="gender">
            <option value="">Select</option>
            <option value="Male" ${patient.Gender === 'Male' ? 'selected' : ''}>Male</option>
            <option value="Female" ${patient.Gender === 'Female' ? 'selected' : ''}>Female</option>
            <option value="Other" ${patient.Gender === 'Other' ? 'selected' : ''}>Other</option>
          </select>
        </div>
      </div>
      <label>Address</label>
      <input type="text" name="address" value="${val('Address')}" placeholder="House/Street">
      <div class="row2">
        <div><label>City</label><input type="text" name="city" value="${val('City')}"></div>
        <div><label>Blood Group</label><input type="text" name="bloodGroup" value="${val('Blood Group')}" placeholder="e.g. O+"></div>
      </div>
      <label>Allergies</label>
      <textarea name="allergies" placeholder="e.g. Penicillin, dust">${val('Allergies')}</textarea>
      <label>Previous Medical History</label>
      <textarea name="medicalHistory" placeholder="e.g. Diabetes, past surgeries">${val('Medical History')}</textarea>
      <label>Current Medicines</label>
      <textarea name="currentMedicines" placeholder="Any medicines you take regularly">${val('Current Medicines')}</textarea>
      <label>Emergency Contact Name</label>
      <input type="text" name="emergencyName" value="${val('Emergency Contact Name')}">
      <div class="row2">
        <div><label>Relation</label><input type="text" name="emergencyRelation" value="${val('Emergency Contact Relation')}" placeholder="e.g. Spouse"></div>
        <div><label>Phone</label><input type="tel" name="emergencyPhone" value="${val('Emergency Contact Phone')}"></div>
      </div>
      <button type="submit">Save Profile</button>
    </form>
  </div>
</body>
</html>`;
}

function buildProfileSavedHtml(clinicName) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Profile Saved</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #eef2f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(15,60,45,0.08); padding: 40px; text-align: center; max-width: 380px; }
  .tick { font-size: 42px; }
  h1 { color: #14532d; font-size: 19px; margin: 12px 0 6px; }
  p { color: #6b7d74; font-size: 13.5px; }
</style></head>
<body>
  <div class="card">
    <div class="tick">✅</div>
    <h1>Profile Updated!</h1>
    <p>Your information has been saved successfully at ${escapeHtml(clinicName)}. You can close this page now.</p>
  </div>
</body></html>`;
}

// Example link sent to patients: https://your-app.onrender.com/patient-profile/<random-token>
app.get('/patient-profile/:token', async (req, res) => {
  try {
    const patient = await sheets.getPatientByProfileToken(req.params.token);
    if (!patient) {
      return res.status(404).send('This link is invalid or has expired. Please contact the clinic for a new link.');
    }
    const settings = await sheets.getSettings();
    const html = buildPatientProfileFormHtml({
      clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
      patient,
      token: req.params.token,
    });
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('patient-profile GET error:', err.message);
    res.status(500).send('Error loading profile page: ' + err.message);
  }
});

app.post('/patient-profile/:token', async (req, res) => {
  try {
    const patient = await sheets.getPatientByProfileToken(req.params.token);
    if (!patient) {
      return res.status(404).send('This link is invalid or has expired. Please contact the clinic for a new link.');
    }
    const phone = String(patient['Phone Number'] || '').replace(/^'/, '');
    await sheets.updatePatientProfileDetails(phone, {
      dob: req.body.dob,
      gender: req.body.gender,
      address: req.body.address,
      city: req.body.city,
      bloodGroup: req.body.bloodGroup,
      allergies: req.body.allergies,
      medicalHistory: req.body.medicalHistory,
      currentMedicines: req.body.currentMedicines,
      emergencyName: req.body.emergencyName,
      emergencyRelation: req.body.emergencyRelation,
      emergencyPhone: req.body.emergencyPhone,
    });
    const settings = await sheets.getSettings();
    res.set('Content-Type', 'text/html');
    res.send(buildProfileSavedHtml(settings.clinicName || CLINIC_NAME_FALLBACK));
  } catch (err) {
    console.error('patient-profile POST error:', err.message);
    res.status(500).send('Error saving profile: ' + err.message);
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

  // Publish the dashboard link into the Settings tab so the clinic can just
  // open the Sheet and copy it, instead of building the URL by hand.
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
