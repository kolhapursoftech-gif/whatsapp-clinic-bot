// reports.js
// Analytics page for the clinic owner: revenue over time, new vs
// follow-up split, top reasons/diagnoses, and expenses vs revenue (net).
// Chart.js is loaded from a CDN — this is a normal server-rendered
// webpage on the clinic's own Render domain, not a claude.ai artifact, so
// there's no content-security restriction on which CDN to use.

const sheets = require('./sheets');
const billing = require('./billing');
const staff = require('./staff');
const { escapeHtml, pageShell, sendUnauthorized } = require('./ui');

function istDateString(offsetDays = 0) {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  ist.setDate(ist.getDate() + offsetDays);
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
}

function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET, CLINIC_NAME_FALLBACK } = ctx;

  app.get('/reports', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET, 'Doctor')) return sendUnauthorized(res);
    try {
      const settings = await sheets.getSettings();
      const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;
      const from = req.query.from || istDateString(-30);
      const to = req.query.to || istDateString(0);

      const [bookings, expenses] = await Promise.all([
        sheets.getBookingsBetween(from, to),
        billing.getExpensesBetween(from, to),
      ]);

      const revenueByDate = {};
      bookings.forEach((b) => {
        if (b['Payment Status'] !== 'Paid') return;
        const d = sheets.stripQuote(b.Date);
        revenueByDate[d] = (revenueByDate[d] || 0) + (parseFloat(b.Fee) || 0);
      });
      const sortedDates = Object.keys(revenueByDate).sort();

      const totalRevenue = Object.values(revenueByDate).reduce((a, b) => a + b, 0);
      const totalExpenses = expenses.reduce((sum, e) => sum + (parseFloat(e.Amount) || 0), 0);
      const netAmount = totalRevenue - totalExpenses;

      const newCount = bookings.filter((b) => b['Visit Type'] === 'New').length;
      const followUpCount = bookings.filter((b) => b['Visit Type'] === 'Follow-up').length;

      const reasonCounts = {};
      bookings.forEach((b) => {
        const r = (b.Reason || 'Not specified').trim();
        reasonCounts[r] = (reasonCounts[r] || 0) + 1;
      });
      const topReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

      const noShows = bookings.filter((b) => b['Queue Status'] === 'No-Show').length;
      const completed = bookings.filter((b) => b['Queue Status'] === 'Completed').length;

      const body = `
        <div class="flex-between">
          <h2 style="margin:0;color:var(--green);">Reports — ${escapeHtml(from)} to ${escapeHtml(to)}</h2>
          <form method="get">
            <input type="hidden" name="secret" value="${escapeHtml(req.query.secret || '')}">
            <div class="flex">
              <input type="date" name="from" value="${escapeHtml(from)}">
              <input type="date" name="to" value="${escapeHtml(to)}">
              <button class="btn small" type="submit">Filter</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="grid stat-grid">
            <div class="stat"><div class="num">Rs ${totalRevenue.toFixed(0)}</div><div class="label">Total Revenue</div></div>
            <div class="stat"><div class="num">Rs ${totalExpenses.toFixed(0)}</div><div class="label">Total Expenses</div></div>
            <div class="stat"><div class="num">Rs ${netAmount.toFixed(0)}</div><div class="label">Net</div></div>
            <div class="stat"><div class="num">${bookings.length}</div><div class="label">Total Bookings</div></div>
            <div class="stat"><div class="num">${newCount}</div><div class="label">New Patients</div></div>
            <div class="stat"><div class="num">${followUpCount}</div><div class="label">Follow-ups</div></div>
            <div class="stat"><div class="num">${completed}</div><div class="label">Completed</div></div>
            <div class="stat"><div class="num">${noShows}</div><div class="label">No Shows</div></div>
          </div>
        </div>

        <div class="card">
          <div class="section-title">Revenue Over Time</div>
          <canvas id="revenueChart" height="90"></canvas>
        </div>

        <div class="card">
          <div class="section-title">New vs Follow-up</div>
          <canvas id="visitTypeChart" height="90"></canvas>
        </div>

        <div class="card">
          <div class="section-title">Top Reasons for Visit</div>
          <table>
            <thead><tr><th>Reason</th><th>Count</th></tr></thead>
            <tbody>
              ${topReasons
                .map(([reason, count]) => `<tr><td>${escapeHtml(reason)}</td><td>${count}</td></tr>`)
                .join('') || '<tr><td colspan="2" class="empty">No data.</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="flex" style="margin-top:8px;">
          <a class="btn outline small" href="/expenses?secret=${encodeURIComponent(req.query.secret || '')}">Manage Expenses →</a>
        </div>

        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
        <script>
          const revenueLabels = ${JSON.stringify(sortedDates)};
          const revenueData = ${JSON.stringify(sortedDates.map((d) => revenueByDate[d]))};
          new Chart(document.getElementById('revenueChart'), {
            type: 'line',
            data: { labels: revenueLabels, datasets: [{ label: 'Revenue (Rs)', data: revenueData, borderColor: '#14532d', backgroundColor: 'rgba(20,83,45,0.08)', fill: true, tension: 0.25 }] },
            options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
          });
          new Chart(document.getElementById('visitTypeChart'), {
            type: 'doughnut',
            data: { labels: ['New', 'Follow-up'], datasets: [{ data: [${newCount}, ${followUpCount}], backgroundColor: ['#d4a94f', '#14532d'] }] },
          });
        </script>
      `;
      res.set('Content-Type', 'text/html');
      res.send(pageShell({ title: 'Reports', activeKey: 'dashboard', secret: req.query.secret || '', clinicName, bodyHtml: body }));
    } catch (err) {
      console.error('reports page error:', err.message);
      res.status(500).send('Error: ' + err.message);
    }
  });
}

module.exports = { registerRoutes };
