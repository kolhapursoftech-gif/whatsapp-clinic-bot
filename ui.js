// ui.js
// Shared page shell (nav + design tokens) for every new staff-facing HTML
// page (dashboard, patients, live queue) so they all look like one product
// instead of four different one-off pages. Colors/typography match the
// existing case-paper page (deep green #14532d + gold #d4a94f accent)
// so nothing looks bolted-on.
//
// This is intentionally plain server-rendered HTML + a little inline JS —
// same approach as the existing case-paper/dashboard pages in server.js —
// no build step, no framework, works on Render's free tier as-is.

function escapeHtml(str) {
  return String(str === undefined || str === null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const NAV_ITEMS = [
  { key: 'dashboard', label: '🏠 Dashboard', path: '/dashboard/home' },
  { key: 'appointments', label: '📅 Appointments', path: '/dashboard' },
  { key: 'patients', label: '🧑‍🤝‍🧑 Patients', path: '/patients' },
  { key: 'queue', label: '⏱️ Live Queue', path: '/queue' },
  { key: 'reports', label: '📊 Reports', path: '/reports' },
];

function pageShell({ title, activeKey, secret, clinicName, bodyHtml, extraHead = '' }) {
  const navHtml = NAV_ITEMS.map((item) => {
    const isActive = item.key === activeKey;
    return `<a class="nav-link${isActive ? ' active' : ''}" href="${item.path}?secret=${encodeURIComponent(
      secret || ''
    )}">${item.label}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}${clinicName ? ' - ' + escapeHtml(clinicName) : ''}</title>
<style>
  * { box-sizing: border-box; }
  :root {
    --green: #14532d; --green-dark: #0f3f22; --gold: #d4a94f;
    --bg: #eef2f0; --card: #ffffff; --border: #e0e9e4;
    --text: #1f2b26; --muted: #6b7d74;
  }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; margin: 0; background: var(--bg); color: var(--text); }
  .topbar { background: var(--green); color: #fff; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .topbar h1 { font-size: 17px; margin: 0; font-weight: 700; }
  .nav { display: flex; gap: 6px; flex-wrap: wrap; }
  .nav-link { color: #d7e8dd; text-decoration: none; font-size: 13px; font-weight: 600; padding: 7px 12px; border-radius: 8px; }
  .nav-link:hover { background: rgba(255,255,255,0.12); }
  .nav-link.active { background: var(--gold); color: #14532d; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 22px 16px 60px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(15,60,45,0.05); }
  .grid { display: grid; gap: 14px; }
  .stat-grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .stat { text-align: center; }
  .stat .num { font-size: 26px; font-weight: 700; color: var(--green); }
  .stat .label { font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 9px 8px; font-size: 13px; border-bottom: 1px solid var(--border); text-align: left; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:hover td { background: #f7faf8; }
  a.rowlink { color: var(--green); text-decoration: none; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
  .badge.green { background: #dcf1e6; color: #14532d; }
  .badge.gold { background: #fdecd4; color: #a15c00; }
  .badge.red { background: #fbe1e1; color: #a12727; }
  .badge.gray { background: #eceff0; color: #5b6a63; }
  input[type=text], input[type=search], input[type=date], select, textarea {
    font-family: inherit; font-size: 13.5px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; width: 100%;
  }
  label { font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; display: block; margin-bottom: 4px; }
  .btn { display: inline-block; padding: 9px 18px; background: var(--green); color: #fff; border: none; border-radius: 8px; font-size: 13.5px; font-weight: 600; cursor: pointer; text-decoration: none; }
  .btn:hover { background: var(--green-dark); }
  .btn.outline { background: #fff; color: var(--green); border: 1.5px solid var(--green); }
  .btn.small { padding: 5px 12px; font-size: 12px; }
  .btn.gray { background: #6b7d74; }
  .section-title { font-size: 14px; font-weight: 700; color: var(--green); text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 12px; }
  .empty { color: var(--muted); font-size: 13px; padding: 18px 0; text-align: center; }
  .flex { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .flex-between { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  ${extraHead ? '' : ''}
</style>
${extraHead}
</head>
<body>
  <div class="topbar">
    <h1>${escapeHtml(clinicName || 'Clinic')} — Staff Panel</h1>
    <div class="nav">${navHtml}</div>
  </div>
  <div class="wrap">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

const UNAUTHORIZED_MESSAGE =
  'Unauthorized (401): the ?secret=... in this URL does not match TRIGGER_SECRET on the server. ' +
  'Check for a typo, extra space, or a stale link, then try again.';

function sendUnauthorized(res) {
  return res.status(401).send(UNAUTHORIZED_MESSAGE);
}

module.exports = { pageShell, escapeHtml, NAV_ITEMS, sendUnauthorized, UNAUTHORIZED_MESSAGE };
