// casepaper.js
// The doctor-facing case paper / prescription page.
//
// This is an UPGRADE of the case paper that already existed inline in
// server.js — same URL shape (/case-paper?secret=&phone=&date=&token=) so
// the WhatsApp link sent at booking-confirm time keeps working unchanged.
// What's new: a Case Paper Number badge (auto-generated on first open via
// counters.js), a patient history panel (allergies / medical history /
// last 5 diagnoses, pulled via records.js), and a "Save Diagnosis &
// Prescription" button that POSTs to /case-paper/save and persists into
// the Records tab (records.js) instead of only living in the browser.

const sheets = require('./sheets');
const staff = require('./staff');
const records = require('./records');
const doctorsModule = require('./doctors');
const { escapeHtml, sendUnauthorized, NAV_ITEMS } = require('./ui');

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
  medicines = [],
  casePaperNumber,
  patientId,
  history,
  existingRecord,
  saveUrl,
  secret,
  doctors = [],
}) {
  const savedItems = existingRecord && existingRecord['Prescription Items'];
  let prefillMedicines = [];
  try {
    prefillMedicines = savedItems ? JSON.parse(savedItems) : [];
  } catch (e) {
    prefillMedicines = [];
  }
  const rowCount = Math.max(4, prefillMedicines.length);

  const rxRowHtml = (prefill) => `
      <tr>
        <td class="num"></td>
        <td><input type="text" class="med-input" list="medlist" value="${escapeHtml(
          prefill ? prefill.name : ''
        )}" oninput="handleMedInput(this)" onchange="handleMedInput(this)" autocomplete="off" placeholder="Type to search medicine..."></td>
        <td contenteditable="true" class="center cell-morning">${escapeHtml(prefill ? prefill.morning : '')}</td>
        <td contenteditable="true" class="center cell-evening">${escapeHtml(prefill ? prefill.evening : '')}</td>
        <td contenteditable="true" class="center cell-before">${escapeHtml(prefill ? prefill.beforeMeal : '')}</td>
        <td contenteditable="true" class="center cell-after">${escapeHtml(prefill ? prefill.afterMeal : '')}</td>
        <td contenteditable="true" class="center cell-days">${escapeHtml(prefill ? prefill.days : '')}</td>
      </tr>`;
  const rxRows = Array.from({ length: rowCount })
    .map((_, i) => rxRowHtml(prefillMedicines[i]))
    .join('');

  const medicineOptions = medicines.map((m) => `<option value="${escapeHtml(m.name)}">`).join('');
  const medicineDbJson = JSON.stringify(
    medicines.reduce((acc, m) => {
      acc[m.name] = { morning: m.morning, evening: m.evening, beforeMeal: m.beforeMeal, afterMeal: m.afterMeal };
      return acc;
    }, {})
  );

  const contactLine = [clinicAddress, clinicPhone ? `📞 ${clinicPhone}` : ''].filter(Boolean).join('  •  ');

  const historyHtml =
    history && (history.allergies || history.medicalHistory || history.currentMedicines || history.pastVisits.length)
      ? `
  <div class="history-box">
    <span class="label">🩺 Patient History</span>
    ${history.allergies ? `<div class="hrow"><b>Allergies:</b> ${escapeHtml(history.allergies)}</div>` : ''}
    ${history.medicalHistory ? `<div class="hrow"><b>Medical History:</b> ${escapeHtml(history.medicalHistory)}</div>` : ''}
    ${history.currentMedicines ? `<div class="hrow"><b>Current Medicines:</b> ${escapeHtml(history.currentMedicines)}</div>` : ''}
    ${
      history.pastVisits.length
        ? `<div class="hrow"><b>Recent Visits:</b> ${history.pastVisits
            .map((v) => `${escapeHtml(v.Date)} — ${escapeHtml(v.Diagnosis || v['Doctor Notes'] || '-')}`)
            .join(' | ')}</div>`
        : ''
    }
  </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Case Paper - ${escapeHtml(name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; margin: 0; padding: 32px 16px; color: #1f2b26; background: #eef2f0; }
  .sheet { max-width: 840px; margin: 0 auto; background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(15, 60, 45, 0.08); padding: 40px 44px 32px; }
  .header { text-align: center; padding-bottom: 20px; margin-bottom: 26px; border-bottom: 3px solid #14532d; position: relative; }
  .header::after { content: ''; position: absolute; left: 50%; bottom: -3px; transform: translateX(-50%); width: 70px; height: 3px; background: #d4a94f; }
  .header h1 { margin: 0; color: #14532d; font-size: 27px; font-weight: 700; letter-spacing: 0.01em; }
  .header .contact { margin: 8px 0 0; color: #6b7d74; font-size: 12.5px; }
  .header .subtitle { margin: 12px 0 0; color: #b8862f; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; }
  .cp-number { margin-top: 6px; font-size: 12px; color: #14532d; font-weight: 700; letter-spacing: 0.04em; }
  .patient-info { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px 24px; background: #f7faf8; border: 1px solid #e0e9e4; border-radius: 12px; padding: 20px 24px; margin-bottom: 18px; }
  .patient-info .full { grid-column: 1 / -1; }
  .patient-info span.label { color: #7c8f85; display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3px; font-weight: 600; }
  .patient-info span.value { font-weight: 600; color: #1f2b26; font-size: 14.5px; }
  .badge { display: inline-block; padding: 3px 13px; border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.02em; }
  .badge.new { background: #fdecd4; color: #a15c00; }
  .badge.followup { background: #dcf1e6; color: #14532d; }
  .history-box { background: #fffaf0; border: 1px solid #f0e0bb; border-radius: 12px; padding: 14px 18px; margin-bottom: 18px; font-size: 12.5px; }
  .history-box .label { color: #a15c00; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; display: block; margin-bottom: 6px; }
  .history-box .hrow { margin-bottom: 3px; color: #4a4230; }
  .diag-box { margin-bottom: 18px; }
  .diag-box label { display: block; font-size: 10.5px; color: #7c8f85; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px; }
  .diag-box textarea { width: 100%; border: 1px solid #dbe5e0; border-radius: 8px; padding: 9px 11px; font-family: inherit; font-size: 13.5px; resize: vertical; margin-bottom: 12px; }
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
  .signature-row { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 50px; padding: 0 6px; }
  .signature-block { text-align: center; width: 220px; }
  .signature-line { border-top: 1.5px solid #9aa8a1; margin-bottom: 8px; height: 36px; }
  .signature-block .label { font-size: 12px; color: #6b7d74; font-weight: 600; }
  .action-row { display: flex; gap: 12px; justify-content: center; margin-top: 28px; flex-wrap: wrap; }
  .print-btn, .save-btn { padding: 13px 32px; border: none; border-radius: 9px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .print-btn { background: #14532d; color: #fff; box-shadow: 0 2px 8px rgba(20,83,45,0.25); }
  .print-btn:hover { background: #0f3f22; }
  .save-btn { background: #d4a94f; color: #4a3200; }
  .save-btn:hover { background: #c49a3f; }
  .add-row-btn { display: block; margin: 12px 0 0; padding: 8px 16px; background: #fff; color: #14532d; border: 1.5px dashed #9aa8a1; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .add-row-btn:hover { border-color: #14532d; }
  .save-status { text-align: center; font-size: 12.5px; margin-top: 10px; color: #14532d; font-weight: 600; min-height: 16px; }
  @media print {
    .no-print { display: none !important; }
    body { padding: 0; background: #fff; }
    .sheet { box-shadow: none; border-radius: 0; padding: 0; max-width: 100%; }
  }
  .staff-nav { max-width: 840px; margin: 0 auto 14px; display: flex; gap: 6px; flex-wrap: wrap; }
  .staff-nav a { font-size: 12.5px; font-weight: 600; color: #14532d; text-decoration: none; padding: 7px 14px; border: 1.5px solid #14532d; border-radius: 8px; background: #fff; }
  .staff-nav a:hover { background: #14532d; color: #fff; }
  .staff-nav a.active { background: #d4a94f; border-color: #d4a94f; color: #4a3200; }
</style>
</head>
<body>
<div class="staff-nav no-print">
  ${NAV_ITEMS.map(
    (item) =>
      `<a href="${item.path}?secret=${encodeURIComponent(secret || '')}">${item.label}</a>`
  ).join('')}
</div>
<div class="sheet">

  <div class="header">
    <h1>${escapeHtml(clinicName)}</h1>
    ${contactLine ? `<p class="contact">${escapeHtml(contactLine)}</p>` : ''}
    <p class="subtitle">Case Paper &amp; Prescription</p>
    ${casePaperNumber ? `<p class="cp-number">${escapeHtml(casePaperNumber)}${patientId ? '  •  ' + escapeHtml(patientId) : ''}</p>` : ''}
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

  ${historyHtml}

  <div class="diag-box no-print">
    ${
      doctors && doctors.length
        ? `<label>Seen By (Doctor)</label>
    <select id="doctorSelect">
      ${doctors
        .map(
          (d) =>
            `<option value="${escapeHtml(d.id)}" ${
              (existingRecord && existingRecord['Doctor ID']) === d.id ? 'selected' : ''
            }>${escapeHtml(d.name)}</option>`
        )
        .join('')}
    </select>`
        : ''
    }
    <label>Diagnosis</label>
    <textarea id="diagnosisInput" rows="2" placeholder="Doctor's diagnosis...">${escapeHtml(
      existingRecord ? existingRecord.Diagnosis : ''
    )}</textarea>
    <label>Doctor Notes</label>
    <textarea id="notesInput" rows="2" placeholder="Additional notes...">${escapeHtml(
      existingRecord ? existingRecord['Doctor Notes'] : ''
    )}</textarea>
  </div>

  <datalist id="medlist">${medicineOptions}</datalist>

  <h2 class="rx">Prescription</h2>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Medicine Name</th><th>Morning</th><th>Evening</th><th>Before Meal</th><th>After Meal</th><th>Days</th>
      </tr>
    </thead>
    <tbody id="rxBody">
      ${rxRows}
    </tbody>
  </table>

  <button class="add-row-btn no-print" onclick="addRxRow()">+ Add Medicine Row</button>

  <div class="signature-row">
    <div class="signature-block"><div class="signature-line"></div><div class="label">Date</div></div>
    <div class="signature-block"><div class="signature-line"></div><div class="label">${
      doctorName ? escapeHtml(doctorName) : "Doctor's Signature"
    }</div></div>
  </div>

  <div class="action-row no-print">
    <button class="save-btn" onclick="saveDiagnosis()">💾 Save Diagnosis &amp; Prescription</button>
    <button class="print-btn" onclick="window.print()">🖨️ Print Case Paper</button>
  </div>
  <div class="save-status no-print" id="saveStatus"></div>
</div>

<script>
  const MEDICINE_DB = ${medicineDbJson};
  function tickIfSet(value) { return value && String(value).trim() ? value : ''; }
  function handleMedInput(input) {
    const med = MEDICINE_DB[input.value];
    if (!med) return;
    const row = input.closest('tr');
    row.querySelector('.cell-morning').textContent = tickIfSet(med.morning) ? '✓' : '';
    row.querySelector('.cell-evening').textContent = tickIfSet(med.evening) ? '✓' : '';
    row.querySelector('.cell-before').textContent = tickIfSet(med.beforeMeal) ? '✓' : '';
    row.querySelector('.cell-after').textContent = tickIfSet(med.afterMeal) ? '✓' : '';
  }

  let rxRowCount = ${rowCount};
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

  async function saveDiagnosis() {
    const statusEl = document.getElementById('saveStatus');
    const medicines = Array.from(document.querySelectorAll('#rxBody tr')).map((row) => ({
      name: row.querySelector('.med-input').value,
      morning: row.querySelector('.cell-morning').textContent,
      evening: row.querySelector('.cell-evening').textContent,
      beforeMeal: row.querySelector('.cell-before').textContent,
      afterMeal: row.querySelector('.cell-after').textContent,
      days: row.querySelector('.cell-days').textContent,
    })).filter((m) => m.name && m.name.trim());

    statusEl.textContent = 'Saving...';
    try {
      const doctorSelectEl = document.getElementById('doctorSelect');
      const res = await fetch(${JSON.stringify(saveUrl)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          diagnosis: document.getElementById('diagnosisInput').value,
          notes: document.getElementById('notesInput').value,
          medicines,
          doctorId: doctorSelectEl ? doctorSelectEl.value : '',
        }),
      });
      if (!res.ok) throw new Error('Save failed (' + res.status + ')');
      statusEl.textContent = '✅ Saved to patient record.';
    } catch (err) {
      statusEl.textContent = '❌ ' + err.message;
    }
  }
</script>
</body>
</html>`;
}

// Registers /case-paper (GET, upgraded) and /case-paper/save (POST, new).
// `ctx` = { app, sheets already required internally, TRIGGER_SECRET, CLINIC_NAME_FALLBACK }
function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET, CLINIC_NAME_FALLBACK } = ctx;

  app.get('/case-paper', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET)) return sendUnauthorized(res);
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
      const doctors = await doctorsModule.listActiveDoctors();

      let casePaperNumber = booking['Case Paper Number'];
      const patientId = booking['Patient ID'];
      if (booking['Booking ID']) {
        // Only bookings created after this upgrade have a Booking ID (and
        // therefore a Case Paper Number to auto-generate). Older bookings
        // just won't show a CP number badge — everything else still works.
        casePaperNumber = await records.ensureCasePaperNumber(booking);
      }

      const history = await records.getHistoryForCasePaper(String(phone), booking.Name, patientId);
      const existingRecord = booking['Booking ID'] ? await sheets.getRecordByBookingId(booking['Booking ID']) : null;

      const saveUrl = `/case-paper/save?${new URLSearchParams({
        secret: TRIGGER_SECRET,
        bookingId: booking['Booking ID'] || '',
      }).toString()}`;

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
        medicines,
        casePaperNumber,
        patientId,
        history,
        existingRecord,
        saveUrl,
        secret: TRIGGER_SECRET,
        doctors,
      });

      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('case-paper error:', err.message);
      res.status(500).send('Error loading case paper: ' + err.message);
    }
  });

  app.post('/case-paper/save', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET)) return sendUnauthorized(res);
    const { bookingId } = req.query;
    if (!bookingId) return res.status(400).json({ error: 'This booking has no Booking ID (created before the upgrade) — nothing to save against.' });

    try {
      const booking = await sheets.getBookingByBookingId(bookingId);
      if (!booking) return res.status(404).json({ error: 'Booking not found.' });

      const settings = await sheets.getSettings();
      const { diagnosis, notes, medicines, doctorId } = req.body || {};

      let doctorName = settings.doctorName;
      if (doctorId) {
        const doctors = await doctorsModule.listActiveDoctors();
        const matched = doctors.find((d) => d.id === doctorId);
        if (matched) doctorName = matched.name;
      }

      const result = await records.saveDiagnosis({
        booking,
        patientId: booking['Patient ID'],
        doctorId: doctorId || '',
        doctorName,
        diagnosis,
        notes,
        medicines,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('case-paper/save error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { buildCasePaperHtml, registerRoutes };
