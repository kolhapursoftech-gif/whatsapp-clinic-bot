// staff.js
// Lightweight multi-staff login, layered ON TOP of the existing
// ?secret=TRIGGER_SECRET scheme — it is NOT replaced. Any link already
// using ?secret=... (case-paper links already sent over WhatsApp,
// bookmarks, etc.) keeps working forever. This adds a SECOND way in: an
// individual staff member logs in once with a short PIN and gets a
// session cookie, so the clinic doesn't have to share one secret with
// every receptionist and doctor.
//
// Roles: 'Admin' > 'Doctor' > 'Receptionist' (used only for a couple of
// gated pages — Reports and Expenses — via isAuthorized(req, secret, role);
// everything else just needs isAuthorized(req, secret), i.e. "logged in as
// SOMEONE, or has the master secret").
//
// Session mechanism: a signed cookie (HMAC-SHA256 over staffId+role+exp,
// keyed by TRIGGER_SECRET so no extra env var is needed). No database
// session table, no extra npm dependency (cookie parsing is done by hand
// — the format is simple enough not to need the `cookie` package).

const crypto = require('crypto');
const sheets = require('./sheets');
const counters = require('./counters');
const { escapeHtml, pageShell } = require('./ui');

const COOKIE_NAME = 'clinic_staff_session';
const SESSION_DAYS = 14;

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function makeSessionCookieValue(staffId, name, role, secret) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${staffId}|${encodeURIComponent(name)}|${role}|${exp}`;
  const sig = sign(payload, secret);
  return `${payload}|${sig}`;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    acc[key] = decodeURIComponent(val);
    return acc;
  }, {});
}

function verifySessionCookie(cookieValue, secret) {
  if (!cookieValue) return null;
  const parts = cookieValue.split('|');
  if (parts.length !== 5) return null;
  const [staffId, encName, role, expStr, sig] = parts;
  const payload = `${staffId}|${encName}|${role}|${expStr}`;
  const expected = sign(payload, secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  const exp = parseInt(expStr, 10);
  if (!exp || Date.now() > exp) return null;
  return { staffId, name: decodeURIComponent(encName), role };
}

function getSession(req, secret) {
  const cookies = parseCookies(req);
  return verifySessionCookie(cookies[COOKIE_NAME], secret);
}

const ROLE_RANK = { Receptionist: 1, Doctor: 2, Admin: 3 };

// Authorization check used by every protected route: true if EITHER the
// master ?secret= matches, OR there's a valid staff session with at least
// `minRole` rank (default: any logged-in staff member).
function isAuthorized(req, TRIGGER_SECRET, minRole) {
  if (req.query.secret && req.query.secret === TRIGGER_SECRET) return true;
  const session = getSession(req, TRIGGER_SECRET);
  if (!session) return false;
  if (!minRole) return true;
  return (ROLE_RANK[session.role] || 0) >= (ROLE_RANK[minRole] || 0);
}

function buildLoginPageHtml({ clinicName, error }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Staff Login - ${escapeHtml(clinicName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #eef2f0; margin: 0; padding: 60px 16px; }
  .card { max-width: 340px; margin: 0 auto; background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(15,60,45,0.08); padding: 32px 28px; text-align: center; }
  h1 { color: #14532d; font-size: 19px; margin: 0 0 4px; }
  p.sub { color: #6b7d74; font-size: 13px; margin: 0 0 22px; }
  input { width: 100%; font-size: 22px; letter-spacing: 0.3em; text-align: center; padding: 12px; border: 1.5px solid #dbe5e0; border-radius: 8px; margin-bottom: 14px; }
  button { width: 100%; padding: 12px; background: #14532d; color: #fff; border: none; border-radius: 8px; font-size: 14.5px; font-weight: 600; cursor: pointer; }
  button:hover { background: #0f3f22; }
  .error { color: #a12727; font-size: 12.5px; margin-bottom: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(clinicName)}</h1>
    <p class="sub">Staff Login — enter your PIN</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST">
      <input type="password" name="pin" inputmode="numeric" autocomplete="off" autofocus maxlength="8" placeholder="••••">
      <button type="submit">Log In</button>
    </form>
  </div>
</body>
</html>`;
}

function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET, CLINIC_NAME_FALLBACK } = ctx;

  app.get('/staff/login', async (req, res) => {
    try {
      const settings = await sheets.getSettings();
      res.set('Content-Type', 'text/html');
      res.send(buildLoginPageHtml({ clinicName: settings.clinicName || CLINIC_NAME_FALLBACK }));
    } catch (err) {
      console.error('staff/login GET error:', err.message);
      res.status(500).send('Error loading login page: ' + err.message);
    }
  });

  app.post('/staff/login', async (req, res) => {
    const settings = await sheets.getSettings();
    const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;
    const pin = (req.body && req.body.pin) || '';

    try {
      // Super-admin PIN (Settings tab) bypasses the Staff list entirely.
      if (settings.adminPin && pin === settings.adminPin) {
        const cookieVal = makeSessionCookieValue('admin', 'Admin', 'Admin', TRIGGER_SECRET);
        res.setHeader(
          'Set-Cookie',
          `${COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Path=/; SameSite=Lax`
        );
        return res.redirect('/dashboard/home');
      }

      const { rows, header } = await sheets.readTab('Staff');
      const pinIdx = header.indexOf('PIN');
      const activeIdx = header.indexOf('Active');
      const idIdx = header.indexOf('Staff ID');
      const nameIdx = header.indexOf('Name');
      const roleIdx = header.indexOf('Role');

      const match = rows.find((r) => pinIdx !== -1 && (r[pinIdx] || '').trim() === pin.trim());
      if (!match || (activeIdx !== -1 && (match[activeIdx] || '').trim().toLowerCase() === 'no')) {
        res.set('Content-Type', 'text/html');
        return res.status(401).send(buildLoginPageHtml({ clinicName, error: 'Wrong PIN, or this staff account is inactive.' }));
      }

      const staffId = match[idIdx] || 'staff';
      const name = match[nameIdx] || 'Staff';
      const role = match[roleIdx] || 'Receptionist';
      const cookieVal = makeSessionCookieValue(staffId, name, role, TRIGGER_SECRET);
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Path=/; SameSite=Lax`
      );
      res.redirect('/dashboard/home');
    } catch (err) {
      console.error('staff login error:', err.message);
      res.status(500).send('Login failed: ' + err.message);
    }
  });

  app.get('/staff/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/`);
    res.redirect('/staff/login');
  });

  // Simple staff management page (Admin only). List + add-new-staff form.
  app.get('/staff', async (req, res) => {
    if (!isAuthorized(req, TRIGGER_SECRET, 'Admin')) {
      res.set('Content-Type', 'text/html');
      return res.status(401).send(buildLoginPageHtml({ clinicName: CLINIC_NAME_FALLBACK, error: 'Admin access needed.' }));
    }
    try {
      const settings = await sheets.getSettings();
      const clinicName = settings.clinicName || CLINIC_NAME_FALLBACK;
      const { rows, header } = await sheets.readTab('Staff');
      const nameIdx = header.indexOf('Name');
      const roleIdx = header.indexOf('Role');
      const activeIdx = header.indexOf('Active');
      const idIdx = header.indexOf('Staff ID');

      const rowsHtml = rows.length
        ? rows
            .map(
              (r) => `<tr>
        <td>${escapeHtml(r[idIdx])}</td>
        <td>${escapeHtml(r[nameIdx])}</td>
        <td>${escapeHtml(r[roleIdx])}</td>
        <td>${escapeHtml(r[activeIdx] || 'Yes')}</td>
      </tr>`
            )
            .join('')
        : `<tr><td colspan="4" class="empty">No staff added yet.</td></tr>`;

      const secretQS = req.query.secret ? `?secret=${encodeURIComponent(req.query.secret)}` : '';
      const body = `
      <div class="flex-between"><h2 style="margin:0;color:var(--green);">Staff</h2></div>
      <div class="card">
        <table>
          <thead><tr><th>Staff ID</th><th>Name</th><th>Role</th><th>Active</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="card">
        <div class="section-title">Add Staff</div>
        <form method="POST" action="/staff${secretQS}">
          <div class="grid stat-grid">
            <div><label>Name</label><input type="text" name="name" required></div>
            <div><label>Role</label>
              <select name="role">
                <option value="Receptionist">Receptionist</option>
                <option value="Doctor">Doctor</option>
                <option value="Admin">Admin</option>
              </select>
            </div>
            <div><label>PIN (4-8 digits)</label><input type="text" name="pin" required maxlength="8"></div>
          </div>
          <button class="btn" type="submit" style="margin-top:14px;">Add Staff</button>
        </form>
      </div>
    `;
      res.set('Content-Type', 'text/html');
      res.send(pageShell({ title: 'Staff', activeKey: 'dashboard', secret: req.query.secret || '', clinicName, bodyHtml: body }));
    } catch (err) {
      console.error('staff GET error:', err.message);
      res.status(500).send('Error loading staff page: ' + err.message);
    }
  });

  app.post('/staff', async (req, res) => {
    if (!isAuthorized(req, TRIGGER_SECRET, 'Admin')) return res.sendStatus(401);
    try {
      const staffId = await counters.nextStaffId();
      const b = req.body || {};
      const { header } = await sheets.readTab('Staff');
      const row = new Array(header.length).fill('');
      header.forEach((h, i) => {
        if (h === 'Staff ID') row[i] = staffId;
        else if (h === 'Name') row[i] = b.name || '';
        else if (h === 'Role') row[i] = b.role || 'Receptionist';
        else if (h === 'PIN') row[i] = b.pin || '';
        else if (h === 'Active') row[i] = 'Yes';
        else if (h === 'Created At') row[i] = new Date().toISOString();
      });
      await sheets.appendRow('Staff', row);

      const secretQS = req.query.secret ? `?secret=${encodeURIComponent(req.query.secret)}` : '';
      res.redirect(`/staff${secretQS}`);
    } catch (err) {
      console.error('add staff error:', err.message);
      res.status(500).send('Error: ' + err.message);
    }
  });
}

module.exports = { registerRoutes, isAuthorized, getSession, COOKIE_NAME };
