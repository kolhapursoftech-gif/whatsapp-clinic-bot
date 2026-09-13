// dashboard.js
// Three staff-facing pages, all protected the same way the existing
// /dashboard and /case-paper pages already are (?secret=TRIGGER_SECRET):
//
//   GET /dashboard/home        -> today's stats + quick snapshots (Section 9)
//   GET /patients              -> patient list + search (Section 10)
//   GET /patients/:patientId   -> one patient's complete digital file (Section 11)
//
// The ORIGINAL /dashboard route (per-day bookings table) in server.js is
// untouched — this file only ADDS pages, it doesn't replace anything.

const sheets = require('./sheets');
const patientsDomain = require('./patients');
const { pageShell, escapeHtml } = require('./ui');

function istDateString(offsetDays = 0) {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  ist.setDate(ist.getDate() + offsetDays);
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
}

function stat(num, label) {
  return `<div class="stat"><div class="num">${escapeHtml(num)}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

async function buildDashboardHomeHtml({ clinicName, secret }) {
  const todayStr = istDateString(0);
  const [bookings, queueEntries] = await Promise.all([
    sheets.getBookingsForDate(todayStr),
    sheets.getQueueForDate(todayStr),
  ]);

  const totalPatients = bookings.length;
  const newPatients = bookings.filter((b) => b['Visit Type'] === 'New').length;
  const followUpPatients = bookings.filter((b) => b['Visit Type'] === 'Follow-up').length;
  const freeAppointments = bookings.filter((b) => b['Payment Status'] === 'Free').length;
  const paymentPending = bookings.filter((b) =>
    ['Pending', 'Screenshot Received', 'Under Verification'].includes(b['Payment Status'])
  ).length;
  const paidAmount = bookings
    .filter((b) => b['Payment Status'] === 'Paid')
    .reduce((sum, b) => sum + (parseInt(b.Fee, 10) || 0), 0);

  const waitingPatients = queueEntries.filter((e) => ['Waiting', 'Checked-In', 'Called'].includes(e.Status)).length;
  const completedPatients = queueEntries.filter((e) => e.Status === 'Completed').length;
  const noShows = queueEntries.filter((e) => e.Status === 'No-Show').length;

  const upcoming = bookings
    .filter((b) => !['Completed', 'No-Show'].includes(b['Queue Status']))
    .sort((a, b) => (parseInt(a['Token Number'], 10) || 0) - (parseInt(b['Token Number'], 10) || 0))
    .slice(0, 6);

  const pendingPayments = bookings.filter((b) =>
    ['Pending', 'Screenshot Received', 'Under Verification'].includes(b['Payment Status'])
  );

  const allPatients = await sheets.getAllPatients();
  const recentPatients = [...allPatients]
    .sort((a, b) => String(b['Last Visit Date'] || '').localeCompare(String(a['Last Visit Date'] || '')))
    .slice(0, 6);

  const listRows = (items, renderer) =>
    items.length ? items.map(renderer).join('') : `<tr><td colspan="4" class="empty">Nothing to show.</td></tr>`;

  const body = `
    <div class="flex-between">
      <h2 style="margin:0;color:var(--green);">Dashboard — ${escapeHtml(todayStr)}</h2>
      <form method="get" action="/patients">
        <input type="hidden" name="secret" value="${escapeHtml(secret)}">
        <div class="flex">
          <input type="search" name="q" placeholder="🔍 Search Name / Phone / Patient ID / Booking ID" style="min-width:260px;">
          <button class="btn small" type="submit">Search</button>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="section-title">Today's Snapshot</div>
      <div class="grid stat-grid">
        ${stat(totalPatients, "Today's Total")}
        ${stat(newPatients, 'New Patients')}
        ${stat(followUpPatients, 'Follow-up')}
        ${stat(waitingPatients, 'Waiting')}
        ${stat(completedPatients, 'Completed')}
        ${stat(paymentPending, 'Payment Pending')}
        ${stat('Rs ' + paidAmount, 'Paid Amount')}
        ${stat(freeAppointments, 'Free Appointments')}
        ${stat(noShows, 'No Shows')}
      </div>
    </div>

    <div class="card">
      <div class="flex-between"><div class="section-title" style="margin:0;">Upcoming Appointments (Today)</div><a class="btn small outline" href="/queue?secret=${encodeURIComponent(secret)}">Open Live Queue →</a></div>
      <table>
        <thead><tr><th>Token</th><th>Name</th><th>Time</th><th>Status</th></tr></thead>
        <tbody>${listRows(
          upcoming,
          (b) =>
            `<tr><td><b>${escapeHtml(b['Token Number'])}</b></td><td>${escapeHtml(b.Name)}</td><td>${escapeHtml(
              sheets.stripQuote(b.Slot)
            )}</td><td>${escapeHtml(b['Queue Status'] || 'Waiting')}</td></tr>`
        )}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="section-title">Pending Payments</div>
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${listRows(
          pendingPayments,
          (b) =>
            `<tr><td>${escapeHtml(b.Name)}</td><td>${escapeHtml(sheets.stripQuote(b['Phone Number']))}</td><td>Rs ${escapeHtml(
              b.Fee || '-'
            )}</td><td>${escapeHtml(b['Payment Status'])}</td></tr>`
        )}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="section-title">Recent Patients</div>
      <table>
        <thead><tr><th>Patient ID</th><th>Name</th><th>Last Visit</th><th></th></tr></thead>
        <tbody>${listRows(
          recentPatients,
          (p) =>
            `<tr><td>${escapeHtml(p['Patient ID'])}</td><td>${escapeHtml(p.Name)}</td><td>${escapeHtml(
              sheets.stripQuote(p['Last Visit Date'] || '')
            )}</td><td>${
              p['Patient ID']
                ? `<a class="rowlink" href="/patients/${encodeURIComponent(p['Patient ID'])}?secret=${encodeURIComponent(
                    secret
                  )}">View →</a>`
                : ''
            }</td></tr>`
        )}</tbody>
      </table>
    </div>
  `;

  return pageShell({ title: 'Dashboard', activeKey: 'dashboard', secret, clinicName, bodyHtml: body });
}

async function buildPatientsListHtml({ clinicName, secret, query }) {
  const results = query ? await patientsDomain.search(query) : await patientsDomain.listAll();
  const sorted = [...results].sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || '')));

  const rows = sorted.length
    ? sorted
        .map(
          (p) => `<tr>
        <td>${escapeHtml(p['Patient ID'] || '-')}</td>
        <td><a class="rowlink" href="/patients/${encodeURIComponent(p['Patient ID'] || '')}?secret=${encodeURIComponent(
          secret
        )}">${escapeHtml(p.Name)}</a></td>
        <td>${escapeHtml(sheets.stripQuote(p['Phone Number']))}</td>
        <td>${escapeHtml(p.Age)}</td>
        <td>${escapeHtml(p['Total Visits'] || '0')}</td>
        <td>${escapeHtml(sheets.stripQuote(p['Last Visit Date'] || '-'))}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="empty">No patients found.</td></tr>`;

  const body = `
    <div class="flex-between">
      <h2 style="margin:0;color:var(--green);">Patients</h2>
      <form method="get">
        <input type="hidden" name="secret" value="${escapeHtml(secret)}">
        <div class="flex">
          <input type="search" name="q" value="${escapeHtml(query || '')}" placeholder="🔍 Search Name / Phone / Patient ID">
          <button class="btn small" type="submit">Search</button>
        </div>
      </form>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Patient ID</th><th>Name</th><th>Phone</th><th>Age</th><th>Total Visits</th><th>Last Visit</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  return pageShell({ title: 'Patients', activeKey: 'patients', secret, clinicName, bodyHtml: body });
}

async function buildPatientDetailHtml({ clinicName, secret, patientId }) {
  const patient = await patientsDomain.getByPatientId(patientId);
  if (!patient) return null;

  const { events, files } = await patientsDomain.getPatientTimeline(patientId);

  const timelineHtml = events.length
    ? events
        .map((ev) => {
          if (ev.kind === 'appointment') {
            const b = ev.data;
            return `<tr><td>${escapeHtml(ev.date)}</td><td><span class="badge green">Appointment</span></td><td>Token ${escapeHtml(
              b['Token Number']
            )} — ${escapeHtml(b.Reason || '-')} (${escapeHtml(b['Visit Type'])})</td></tr>`;
          }
          const r = ev.data;
          return `<tr><td>${escapeHtml(ev.date)}</td><td><span class="badge gold">Record</span></td><td>${escapeHtml(
            r.Diagnosis || r['Doctor Notes'] || '-'
          )} ${r['Case Paper Number'] ? '(' + escapeHtml(r['Case Paper Number']) + ')' : ''}</td></tr>`;
        })
        .join('')
    : `<tr><td colspan="3" class="empty">No appointments or records yet.</td></tr>`;

  const filesHtml = files.length
    ? files
        .map(
          (f) => `<tr>
        <td>${escapeHtml(f['File Name'])}</td>
        <td>${escapeHtml(f['File Type'])}</td>
        <td>${escapeHtml(sheets.stripQuote(f['Uploaded At'] || ''))}</td>
        <td>
          <a class="btn small outline" href="${escapeHtml(f['Google Drive URL'])}" target="_blank">Open</a>
          <form method="POST" action="/files/${encodeURIComponent(f['File ID'])}/delete?secret=${encodeURIComponent(
            secret
          )}" style="display:inline" onsubmit="return confirm('Delete this file?')"><button class="btn small gray" type="submit">Delete</button></form>
        </td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="4" class="empty">No files uploaded yet.</td></tr>`;

  const body = `
    <div class="flex-between">
      <h2 style="margin:0;color:var(--green);">${escapeHtml(patient.Name)} <span style="color:var(--muted);font-weight:400;font-size:14px;">(${escapeHtml(
        patientId
      )})</span></h2>
      <a class="btn small outline" href="/patients?secret=${encodeURIComponent(secret)}">← Back to Patients</a>
    </div>

    <div class="card">
      <div class="section-title">Personal &amp; Emergency Information</div>
      <div class="grid stat-grid" style="text-align:left;">
        <div><label>Phone</label>${escapeHtml(sheets.stripQuote(patient['Phone Number']))}</div>
        <div><label>Age</label>${escapeHtml(patient.Age)}</div>
        <div><label>Gender</label>${escapeHtml(patient.Gender || '-')}</div>
        <div><label>City</label>${escapeHtml(patient.City || '-')}</div>
        <div><label>Blood Group</label>${escapeHtml(patient['Blood Group'] || '-')}</div>
        <div><label>Total Visits</label>${escapeHtml(patient['Total Visits'] || '0')}</div>
        <div><label>Emergency Contact</label>${escapeHtml(patient['Emergency Contact Name'] || '-')} (${escapeHtml(
          patient['Emergency Contact Relation'] || '-'
        )}) — ${escapeHtml(patient['Emergency Contact Phone'] || '-')}</div>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Medical Information</div>
      <div class="grid stat-grid" style="text-align:left;">
        <div><label>Allergies</label>${escapeHtml(patient.Allergies || '-')}</div>
        <div><label>Medical History</label>${escapeHtml(patient['Medical History'] || '-')}</div>
        <div><label>Current Medicines</label>${escapeHtml(patient['Current Medicines'] || '-')}</div>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Timeline</div>
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>Details</th></tr></thead>
        <tbody>${timelineHtml}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="flex-between"><div class="section-title" style="margin:0;">Files</div></div>
      <table>
        <thead><tr><th>File Name</th><th>Type</th><th>Uploaded</th><th>Action</th></tr></thead>
        <tbody>${filesHtml}</tbody>
      </table>
      <form method="POST" action="/patients/${encodeURIComponent(patientId)}/files?secret=${encodeURIComponent(
        secret
      )}" enctype="multipart/form-data" style="margin-top:12px;" class="flex">
        <input type="file" name="file" required>
        <button class="btn small" type="submit">Upload File</button>
      </form>
    </div>
  `;

  return pageShell({ title: patient.Name, activeKey: 'patients', secret, clinicName, bodyHtml: body });
}

function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET, CLINIC_NAME_FALLBACK } = ctx;

  app.get('/dashboard/home', async (req, res) => {
    if (req.query.secret !== TRIGGER_SECRET) return res.sendStatus(401);
    try {
      const settings = await sheets.getSettings();
      const html = await buildDashboardHomeHtml({
        clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
        secret: TRIGGER_SECRET,
      });
      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('dashboard/home error:', err.message);
      res.status(500).send('Error loading dashboard: ' + err.message);
    }
  });

  app.get('/patients', async (req, res) => {
    if (req.query.secret !== TRIGGER_SECRET) return res.sendStatus(401);
    try {
      const settings = await sheets.getSettings();
      const html = await buildPatientsListHtml({
        clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
        secret: TRIGGER_SECRET,
        query: req.query.q || '',
      });
      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('patients list error:', err.message);
      res.status(500).send('Error loading patients: ' + err.message);
    }
  });

  app.get('/patients/:patientId', async (req, res) => {
    if (req.query.secret !== TRIGGER_SECRET) return res.sendStatus(401);
    try {
      const settings = await sheets.getSettings();
      const html = await buildPatientDetailHtml({
        clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
        secret: TRIGGER_SECRET,
        patientId: req.params.patientId,
      });
      if (!html) return res.status(404).send('Patient not found.');
      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('patient detail error:', err.message);
      res.status(500).send('Error loading patient: ' + err.message);
    }
  });
}

module.exports = { registerRoutes };
