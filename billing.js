// billing.js
// Two things: (1) Expenses — a simple log so the clinic can see money out
// alongside money in (Fee/Payment Status already on every booking), used
// by reports.js for a Net figure; (2) a printable Invoice/Receipt for a
// single booking, in the same visual language as the case paper.

const sheets = require('./sheets');
const counters = require('./counters');
const staff = require('./staff');
const { escapeHtml, pageShell, sendUnauthorized } = require('./ui');

function istDateString(offsetDays = 0) {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  ist.setDate(ist.getDate() + offsetDays);
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
}

async function getExpensesBetween(fromDate, toDate) {
  const { rows, header } = await sheets.readTab('Expenses');
  const dateIdx = header.indexOf('Date');
  const amountIdx = header.indexOf('Amount');
  if (dateIdx === -1) return [];
  return rows
    .filter((r) => {
      const d = sheets.stripQuote(r[dateIdx]);
      return d >= fromDate && d <= toDate;
    })
    .map((r) => sheets.rowToObject(header, r));
}

function buildInvoiceHtml({ clinicName, clinicAddress, clinicPhone, booking }) {
  const contactLine = [clinicAddress, clinicPhone ? `📞 ${clinicPhone}` : ''].filter(Boolean).join('  •  ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice - ${escapeHtml(booking.Name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 32px 16px; background: #eef2f0; color: #1f2b26; }
  .sheet { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(15,60,45,0.08); padding: 36px 40px; }
  .header { text-align: center; padding-bottom: 18px; margin-bottom: 22px; border-bottom: 3px solid #14532d; }
  .header h1 { margin: 0; color: #14532d; font-size: 24px; }
  .header .contact { color: #6b7d74; font-size: 12px; margin: 6px 0 0; }
  .header .subtitle { margin: 10px 0 0; color: #b8862f; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; }
  td { padding: 8px 0; font-size: 14px; border-bottom: 1px solid #e5ece8; }
  td.label { color: #7c8f85; width: 45%; }
  td.value { font-weight: 600; text-align: right; }
  .total-row td { font-size: 18px; font-weight: 700; color: #14532d; border-bottom: none; padding-top: 14px; }
  .badge { display: inline-block; padding: 3px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; }
  .badge.paid { background: #dcf1e6; color: #14532d; }
  .badge.pending { background: #fdecd4; color: #a15c00; }
  .print-btn { display: block; width: 100%; margin-top: 24px; padding: 13px; background: #14532d; color: #fff; border: none; border-radius: 9px; font-size: 15px; font-weight: 600; cursor: pointer; }
  @media print { .no-print { display: none !important; } body { padding: 0; background: #fff; } .sheet { box-shadow: none; } }
</style>
</head>
<body>
<div class="sheet">
  <div class="header">
    <h1>${escapeHtml(clinicName)}</h1>
    ${contactLine ? `<p class="contact">${escapeHtml(contactLine)}</p>` : ''}
    <p class="subtitle">Payment Receipt</p>
  </div>
  <table>
    <tr><td class="label">Booking ID</td><td class="value">${escapeHtml(booking['Booking ID'] || '-')}</td></tr>
    <tr><td class="label">Patient Name</td><td class="value">${escapeHtml(booking.Name)}</td></tr>
    <tr><td class="label">Date</td><td class="value">${escapeHtml(sheets.stripQuote(booking.Date))}</td></tr>
    <tr><td class="label">Visit Type</td><td class="value">${escapeHtml(booking['Visit Type'] || '-')}</td></tr>
    <tr><td class="label">Payment Status</td><td class="value"><span class="badge ${
      booking['Payment Status'] === 'Paid' ? 'paid' : 'pending'
    }">${escapeHtml(booking['Payment Status'] || '-')}</span></td></tr>
    <tr class="total-row"><td class="label">Amount</td><td class="value">Rs ${escapeHtml(booking.Fee || '0')}</td></tr>
  </table>
  <button class="print-btn no-print" onclick="window.print()">🖨️ Print Receipt</button>
</div>
</body>
</html>`;
}

function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET, CLINIC_NAME_FALLBACK } = ctx;

  app.get('/invoice', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET)) return sendUnauthorized(res);
    try {
      const booking = await sheets.getBookingByBookingId(req.query.bookingId);
      if (!booking) return res.status(404).send('Booking not found.');
      const settings = await sheets.getSettings();
      res.set('Content-Type', 'text/html');
      res.send(
        buildInvoiceHtml({
          clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
          clinicAddress: settings.clinicAddress,
          clinicPhone: settings.clinicPhone,
          booking,
        })
      );
    } catch (err) {
      console.error('invoice error:', err.message);
      res.status(500).send('Error: ' + err.message);
    }
  });

  app.get('/expenses', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET, 'Doctor')) return sendUnauthorized(res);
    try {
      const settings = await sheets.getSettings();
      const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;
      const from = req.query.from || istDateString(-30);
      const to = req.query.to || istDateString(0);
      const expenses = await getExpensesBetween(from, to);
      const total = expenses.reduce((sum, e) => sum + (parseFloat(e.Amount) || 0), 0);

      const rowsHtml = expenses.length
        ? expenses
            .map(
              (e) => `<tr>
          <td>${escapeHtml(sheets.stripQuote(e.Date))}</td>
          <td>${escapeHtml(e.Category)}</td>
          <td>${escapeHtml(e.Description)}</td>
          <td>Rs ${escapeHtml(e.Amount)}</td>
          <td>${escapeHtml(e['Paid By'])}</td>
        </tr>`
            )
            .join('')
        : `<tr><td colspan="5" class="empty">No expenses logged for this range.</td></tr>`;

      const secretQS = req.query.secret ? `&secret=${encodeURIComponent(req.query.secret)}` : '';
      const body = `
        <div class="flex-between">
          <h2 style="margin:0;color:var(--green);">Expenses</h2>
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
          <div class="section-title">Total: Rs ${total.toFixed(0)}</div>
          <table>
            <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Paid By</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <div class="card">
          <div class="section-title">Add Expense</div>
          <form method="POST" action="/expenses?dummy=1${secretQS}">
            <div class="grid stat-grid">
              <div><label>Date</label><input type="date" name="date" value="${escapeHtml(istDateString(0))}" required></div>
              <div><label>Category</label><input type="text" name="category" placeholder="Rent, Supplies, Salary..." required></div>
              <div><label>Amount</label><input type="number" name="amount" step="0.01" required></div>
              <div><label>Paid By</label><input type="text" name="paidBy"></div>
            </div>
            <div style="margin-top:10px;"><label>Description</label><input type="text" name="description"></div>
            <button class="btn" type="submit" style="margin-top:14px;">Add Expense</button>
          </form>
        </div>
      `;
      res.set('Content-Type', 'text/html');
      res.send(pageShell({ title: 'Expenses', activeKey: 'dashboard', secret: req.query.secret || '', clinicName, bodyHtml: body }));
    } catch (err) {
      console.error('expenses page error:', err.message);
      res.status(500).send('Error: ' + err.message);
    }
  });

  app.post('/expenses', async (req, res) => {
    if (!staff.isAuthorized(req, TRIGGER_SECRET, 'Doctor')) return sendUnauthorized(res);
    try {
      const expenseId = await counters.nextExpenseId();
      const b = req.body || {};
      const { header } = await sheets.readTab('Expenses');
      const row = new Array(header.length).fill('');
      header.forEach((h, i) => {
        if (h === 'Expense ID') row[i] = expenseId;
        else if (h === 'Date') row[i] = b.date ? `'${b.date}` : `'${istDateString(0)}`;
        else if (h === 'Category') row[i] = b.category || '';
        else if (h === 'Description') row[i] = b.description || '';
        else if (h === 'Amount') row[i] = b.amount || '0';
        else if (h === 'Paid By') row[i] = b.paidBy || '';
        else if (h === 'Created At') row[i] = new Date().toISOString();
      });
      await sheets.appendRow('Expenses', row);
      const secretQS = req.query.secret ? `?secret=${encodeURIComponent(req.query.secret)}` : '';
      res.redirect(`/expenses${secretQS}`);
    } catch (err) {
      console.error('add expense error:', err.message);
      res.status(500).send('Error: ' + err.message);
    }
  });
}

module.exports = { registerRoutes, getExpensesBetween };
