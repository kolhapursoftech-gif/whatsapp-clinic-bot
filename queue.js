// queue.js
// The day's live token queue. A Queue row is created automatically the
// moment a booking is finalized (see server.js finalizeBooking) with
// Status = "Waiting". Staff move it through:
//   Waiting -> Checked-In -> Called -> In-Consultation -> Completed
//                                              \-> Skipped / No-Show
//
// "NOW SERVING" = the entry currently In-Consultation (or the most
// recently Called one, if nobody's In-Consultation yet).
// "NEXT" = the next few Waiting/Checked-In entries in token order.

const sheets = require('./sheets');
const staff = require('./staff');
const whatsapp = require('./whatsapp');
const { getMessages } = require('./messages');
const { pageShell, escapeHtml, sendUnauthorized } = require('./ui');

function sortByToken(entries) {
  return [...entries].sort((a, b) => (parseInt(a['Token Number'], 10) || 0) - (parseInt(b['Token Number'], 10) || 0));
}

async function createQueueEntry({ dateStr, tokenNumber, bookingId, patientId }) {
  await sheets.appendQueueEntry({
    Date: `'${dateStr}`,
    'Token Number': tokenNumber,
    'Booking ID': bookingId,
    'Patient ID': patientId || '',
    Status: 'Waiting',
  });
}

async function setStatus(bookingId, status, timeField) {
  const fields = { Status: status };
  if (timeField) fields[timeField] = new Date().toISOString();
  await sheets.updateQueueEntryByBookingId(bookingId, fields);
}

// Sends the "your turn is coming up" WhatsApp alert to whichever Waiting
// patient sits `alertDistance` tokens after the one just called — e.g. if
// token 12 was just called and alertDistance is 2, token 14 gets pinged.
// Best-effort: any failure here should never break the Call action itself.
async function maybeSendQueueAlert({ dateStr, justCalledToken, alertDistance }) {
  try {
    const entries = sortByToken(await sheets.getQueueForDate(dateStr));
    const target = entries.find(
      (e) => parseInt(e['Token Number'], 10) === parseInt(justCalledToken, 10) + alertDistance
    );
    if (!target || (target.Status !== 'Waiting' && target.Status !== 'Checked-In')) return;

    const booking = await sheets.getBookingByBookingId(target['Booking ID']);
    if (!booking) return;
    const phone = sheets.stripQuote(booking['Phone Number']);
    const patient = await sheets.getPatientFullProfile(phone);
    const lang = (patient && patient.Lang) || 'mr';
    const M = getMessages(lang);
    await whatsapp.sendText(phone, M.queueAlert);
  } catch (err) {
    console.warn('queue alert warning:', err.message);
  }
}

function buildQueuePageHtml({ clinicName, dateStr, entries, bookingsByBookingId, secret }) {
  const sorted = sortByToken(entries);
  const nowServing =
    sorted.find((e) => e.Status === 'In-Consultation') || [...sorted].reverse().find((e) => e.Status === 'Called');
  const upcoming = sorted.filter((e) => ['Waiting', 'Checked-In'].includes(e.Status)).slice(0, 5);

  const statusBadge = (status) => {
    const map = {
      Waiting: 'gray',
      'Checked-In': 'gold',
      Called: 'gold',
      'In-Consultation': 'green',
      Completed: 'green',
      Skipped: 'red',
      'No-Show': 'red',
    };
    return `<span class="badge ${map[status] || 'gray'}">${escapeHtml(status)}</span>`;
  };

  const actionButtons = (entry) => {
    const bid = encodeURIComponent(entry['Booking ID']);
    const base = `/queue/${bid}/action?secret=${encodeURIComponent(secret)}&date=${encodeURIComponent(dateStr)}`;
    const btn = (action, label) =>
      `<form method="POST" action="${base}&action=${action}" style="display:inline"><button class="btn small outline" type="submit">${label}</button></form>`;
    switch (entry.Status) {
      case 'Waiting':
        return `${btn('checkin', 'Check In')} ${btn('skip', 'Skip')}`;
      case 'Checked-In':
        return `${btn('call', 'Call')} ${btn('noshow', 'No Show')}`;
      case 'Called':
        return `${btn('start', 'Start Consultation')} ${btn('noshow', 'No Show')}`;
      case 'In-Consultation':
        return `${btn('complete', 'Complete')}`;
      default:
        return '-';
    }
  };

  const rows = sorted.length
    ? sorted
        .map((e) => {
          const booking = bookingsByBookingId[e['Booking ID']] || {};
          return `<tr>
            <td><b>${escapeHtml(e['Token Number'])}</b></td>
            <td>${escapeHtml(booking.Name || '')}</td>
            <td>${statusBadge(e.Status)}</td>
            <td>${actionButtons(e)}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="4" class="empty">No queue entries for this date yet.</td></tr>`;

  const nowServingHtml = nowServing
    ? `<div class="stat"><div class="num">#${escapeHtml(nowServing['Token Number'])}</div><div class="label">Now Serving — ${escapeHtml(
        (bookingsByBookingId[nowServing['Booking ID']] || {}).Name || ''
      )}</div></div>`
    : `<div class="stat"><div class="num">-</div><div class="label">Now Serving</div></div>`;

  const nextHtml = upcoming.length
    ? upcoming
        .map(
          (e) =>
            `<div class="stat"><div class="num">#${escapeHtml(e['Token Number'])}</div><div class="label">${escapeHtml(
              (bookingsByBookingId[e['Booking ID']] || {}).Name || ''
            )}</div></div>`
        )
        .join('')
    : '<div class="empty">No one waiting.</div>';

  const body = `
    <div class="flex-between">
      <h2 style="margin:0;color:var(--green);">Live Queue — ${escapeHtml(dateStr)}</h2>
      <form method="get">
        <input type="hidden" name="secret" value="${escapeHtml(secret)}">
        <input type="date" name="date" value="${escapeHtml(dateStr)}" onchange="this.form.submit()">
      </form>
    </div>

    <div class="card">
      <div class="section-title">Now Serving</div>
      <div class="grid stat-grid">${nowServingHtml}</div>
    </div>

    <div class="card">
      <div class="section-title">Next Up</div>
      <div class="grid stat-grid">${nextHtml}</div>
    </div>

    <div class="card">
      <div class="section-title">All Tokens Today</div>
      <table>
        <thead><tr><th>Token</th><th>Name</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p style="color:var(--muted);font-size:12px;">Page auto-refreshes every 20 seconds.</p>
    <script>setTimeout(() => window.location.reload(), 20000);</script>
  `;

  return pageShell({ title: 'Live Queue', activeKey: 'queue', secret, clinicName, bodyHtml: body });
}

function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET, CLINIC_NAME_FALLBACK } = ctx;

  function istDateString(offsetDays = 0) {
    const now = new Date();
    const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
    const ist = new Date(istMs);
    ist.setDate(ist.getDate() + offsetDays);
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
  }

  app.get('/queue', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET)) return sendUnauthorized(res);
    try {
      const settings = await sheets.getSettings();
      const dateStr = req.query.date || istDateString(0);
      const entries = await sheets.getQueueForDate(dateStr);

      const bookingIds = entries.map((e) => e['Booking ID']).filter(Boolean);
      const bookingsByBookingId = {};
      await Promise.all(
        bookingIds.map(async (bid) => {
          bookingsByBookingId[bid] = await sheets.getBookingByBookingId(bid);
        })
      );

      const html = buildQueuePageHtml({
        clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
        dateStr,
        entries,
        bookingsByBookingId,
        secret: TRIGGER_SECRET,
      });
      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('queue page error:', err.message);
      res.status(500).send('Error loading queue: ' + err.message);
    }
  });

  app.post('/queue/:bookingId/action', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET)) return sendUnauthorized(res);
    const { bookingId } = req.params;
    const { action, date } = req.query;
    try {
      const settings = await sheets.getSettings();
      const alertDistance = parseInt(settings.queueAlertMinutes, 10) || 2;

      const ACTIONS = {
        checkin: ['Checked-In', 'Checked In At'],
        call: ['Called', 'Called At'],
        start: ['In-Consultation', 'Started At'],
        complete: ['Completed', 'Completed At'],
        skip: ['Skipped', null],
        noshow: ['No-Show', null],
      };
      const mapped = ACTIONS[action];
      if (!mapped) return res.status(400).send('Unknown action.');

      await setStatus(bookingId, mapped[0], mapped[1]);
      await sheets.updateBookingByBookingId(bookingId, { 'Queue Status': mapped[0] });

      if (action === 'call') {
        const entry = (await sheets.getQueueForDate(date)).find((e) => e['Booking ID'] === bookingId);
        if (entry) {
          await maybeSendQueueAlert({ dateStr: date, justCalledToken: entry['Token Number'], alertDistance });
        }
      }

      res.redirect(`/queue?secret=${encodeURIComponent(TRIGGER_SECRET)}&date=${encodeURIComponent(date || '')}`);
    } catch (err) {
      console.error('queue action error:', err.message);
      res.status(500).send('Error updating queue: ' + err.message);
    }
  });
}

module.exports = { createQueueEntry, registerRoutes };
