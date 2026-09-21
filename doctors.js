// doctors.js
// Doctors tab management. Scope note: this gives the clinic a place to
// register multiple doctors (name, specialization, own WhatsApp number)
// and see them listed/reported on. It does NOT add a "which doctor?"
// question into the automated WhatsApp booking conversation — that would
// mean touching the booking state machine in server.js, which is the most
// delicate, most-tested part of this whole system, and a wrong move there
// risks breaking live bookings. For now, staff pick which doctor saw the
// patient AT CASE-PAPER TIME (see casepaper.js's doctor dropdown, wired to
// this same Doctors tab), which covers "multiple doctors work here and we
// want that on the record and in reports" without touching the WhatsApp
// flow. If/when a clinic actually needs patients choosing a doctor
// up-front over WhatsApp, that's a deliberate follow-up change, not
// something to slip in as a side effect of this file.

const sheets = require('./sheets');
const counters = require('./counters');
const { escapeHtml, pageShell, sendUnauthorized } = require('./ui');
const staff = require('./staff');

async function listActiveDoctors() {
  const { rows, header } = await sheets.readTab('Doctors');
  const nameIdx = header.indexOf('Name');
  const idIdx = header.indexOf('Doctor ID');
  const activeIdx = header.indexOf('Active');
  return rows
    .filter((r) => activeIdx === -1 || (r[activeIdx] || 'Yes').trim().toLowerCase() !== 'no')
    .map((r) => ({ id: r[idIdx], name: r[nameIdx] }));
}

function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET, CLINIC_NAME_FALLBACK } = ctx;

  app.get('/doctors', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET, 'Admin')) return sendUnauthorized(res);
    try {
      const settings = await sheets.getSettings();
      const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;
      const { rows, header } = await sheets.readTab('Doctors');
      const idIdx = header.indexOf('Doctor ID');
      const nameIdx = header.indexOf('Name');
      const specIdx = header.indexOf('Specialization');
      const phoneIdx = header.indexOf('WhatsApp Number');
      const activeIdx = header.indexOf('Active');

      const rowsHtml = rows.length
        ? rows
            .map(
              (r) => `<tr>
          <td>${escapeHtml(r[idIdx])}</td>
          <td>${escapeHtml(r[nameIdx])}</td>
          <td>${escapeHtml(r[specIdx])}</td>
          <td>${escapeHtml(sheets.stripQuote(r[phoneIdx] || ''))}</td>
          <td>${escapeHtml(r[activeIdx] || 'Yes')}</td>
        </tr>`
            )
            .join('')
        : `<tr><td colspan="5" class="empty">No doctors added yet — the clinic works as a single-doctor setup by default.</td></tr>`;

      const secretQS = req.query.secret ? `?secret=${encodeURIComponent(req.query.secret)}` : '';
      const body = `
        <div class="flex-between"><h2 style="margin:0;color:var(--green);">Doctors</h2></div>
        <div class="card">
          <table>
            <thead><tr><th>Doctor ID</th><th>Name</th><th>Specialization</th><th>WhatsApp</th><th>Active</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <div class="card">
          <div class="section-title">Add Doctor</div>
          <form method="POST" action="/doctors${secretQS}">
            <div class="grid stat-grid">
              <div><label>Name</label><input type="text" name="name" required></div>
              <div><label>Specialization</label><input type="text" name="specialization"></div>
              <div><label>WhatsApp Number</label><input type="text" name="whatsapp"></div>
            </div>
            <button class="btn" type="submit" style="margin-top:14px;">Add Doctor</button>
          </form>
        </div>
      `;
      res.set('Content-Type', 'text/html');
      res.send(pageShell({ title: 'Doctors', activeKey: 'dashboard', secret: req.query.secret || '', clinicName, bodyHtml: body }));
    } catch (err) {
      console.error('doctors page error:', err.message);
      res.status(500).send('Error: ' + err.message);
    }
  });

  app.post('/doctors', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET, 'Admin')) return sendUnauthorized(res);
    try {
      const doctorId = await counters.nextDoctorId();
      const b = req.body || {};
      const { header } = await sheets.readTab('Doctors');
      const row = new Array(header.length).fill('');
      header.forEach((h, i) => {
        if (h === 'Doctor ID') row[i] = doctorId;
        else if (h === 'Name') row[i] = b.name || '';
        else if (h === 'Specialization') row[i] = b.specialization || '';
        else if (h === 'WhatsApp Number') row[i] = b.whatsapp ? `'${b.whatsapp}` : '';
        else if (h === 'Active') row[i] = 'Yes';
        else if (h === 'Created At') row[i] = new Date().toISOString();
      });
      await sheets.appendRow('Doctors', row);
      const secretQS = req.query.secret ? `?secret=${encodeURIComponent(req.query.secret)}` : '';
      res.redirect(`/doctors${secretQS}`);
    } catch (err) {
      console.error('add doctor error:', err.message);
      res.status(500).send('Error: ' + err.message);
    }
  });
}

module.exports = { registerRoutes, listActiveDoctors };
