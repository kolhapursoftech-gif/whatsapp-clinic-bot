// profile.js
// Secure patient-profile link: generated once per booking-confirm and sent
// to the patient over WhatsApp. Patient opens it, fills in personal /
// emergency / medical details themselves, no login needed — the token in
// the URL IS the credential.
//
// Security properties (per the spec):
//   - Phone number and Patient ID are never put in the URL — only the token.
//   - Token is a long random string (32 bytes -> 64 hex chars) — not guessable.
//   - Token has an expiry (default 30 days, configurable via
//     PROFILE_LINK_VALID_DAYS env var); expired tokens are rejected.
//   - The profile page will not render at all unless the token validates.

const crypto = require('crypto');
const sheets = require('./sheets');
const { escapeHtml } = require('./ui');

const TOKEN_VALID_DAYS = parseInt(process.env.PROFILE_LINK_VALID_DAYS, 10) || 30;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Call this once when a booking is confirmed. Returns the full URL to send
// the patient over WhatsApp.
async function createProfileLink(phone, appBaseUrl) {
  const token = generateToken();
  const expiry = new Date(Date.now() + TOKEN_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await sheets.setProfileToken(phone, token, expiry);
  return `${appBaseUrl}/patient-profile/${token}`;
}

async function validateToken(token) {
  if (!token) return null;
  const patient = await sheets.getPatientByProfileToken(token);
  if (!patient) return null;
  const expiry = patient['Profile Token Expiry'];
  if (expiry && new Date(expiry).getTime() < Date.now()) return null;
  return patient;
}

function field(id, label, value, opts = {}) {
  const { type = 'text', textarea = false, required = false } = opts;
  const val = escapeHtml(value || '');
  const inner = textarea
    ? `<textarea id="${id}" name="${id}" rows="2">${val}</textarea>`
    : `<input type="${type}" id="${id}" name="${id}" value="${val}"${required ? ' required' : ''}>`;
  return `<div class="form-row"><label for="${id}">${escapeHtml(label)}</label>${inner}</div>`;
}

function buildProfilePageHtml({ clinicName, patient, saved }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Patient Profile - ${escapeHtml(clinicName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; margin: 0; padding: 24px 16px 60px; background: #eef2f0; color: #1f2b26; }
  .sheet { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 14px; box-shadow: 0 4px 24px rgba(15,60,45,0.08); padding: 30px 26px; }
  h1 { color: #14532d; font-size: 21px; margin: 0 0 4px; }
  p.sub { color: #6b7d74; font-size: 13px; margin: 0 0 22px; }
  .banner { background: #dcf1e6; color: #14532d; border-radius: 10px; padding: 12px 16px; font-size: 13.5px; font-weight: 600; margin-bottom: 20px; }
  .section-title { font-size: 12px; color: #a15c00; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; margin: 22px 0 10px; }
  .form-row { margin-bottom: 13px; }
  label { display: block; font-size: 11.5px; color: #7c8f85; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px; }
  input, textarea, select { width: 100%; font-family: inherit; font-size: 14px; padding: 9px 11px; border: 1px solid #dbe5e0; border-radius: 8px; }
  textarea { resize: vertical; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
  .save-btn { display: block; width: 100%; margin-top: 22px; padding: 13px; background: #14532d; color: #fff; border: none; border-radius: 9px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .save-btn:hover { background: #0f3f22; }
</style>
</head>
<body>
<div class="sheet">
  <h1>${escapeHtml(clinicName)}</h1>
  <p class="sub">Tumcha patient profile — kripaya khali dilela form bharun tumchi mahiti purna kara.</p>

  ${saved ? '<div class="banner">✅ Tumchi mahiti yashasviritya update zali aahe.</div>' : ''}

  <form method="POST">
    <div class="section-title">Personal Information</div>
    ${field('fullName', 'Full Name', patient['Name'] || patient['Full Name'])}
    <div class="grid2">
      ${field('dob', 'Date of Birth', patient['Date of Birth'], { type: 'date' })}
      ${field('age', 'Age', patient['Age'], { type: 'number' })}
    </div>
    <div class="grid2">
      ${field('gender', 'Gender', patient['Gender'])}
      ${field('city', 'City', patient['City'])}
    </div>
    ${field('address', 'Address', patient['Address'], { textarea: true })}

    <div class="section-title">Emergency Contact</div>
    <div class="grid2">
      ${field('emergencyName', 'Contact Name', patient['Emergency Contact Name'])}
      ${field('emergencyRelation', 'Relation', patient['Emergency Contact Relation'])}
    </div>
    ${field('emergencyPhone', 'Contact Phone', patient['Emergency Contact Phone'], { type: 'tel' })}

    <div class="section-title">Medical Information</div>
    <div class="grid2">
      ${field('bloodGroup', 'Blood Group', patient['Blood Group'])}
    </div>
    ${field('allergies', 'Allergies', patient['Allergies'], { textarea: true })}
    ${field('medicalHistory', 'Previous Medical History', patient['Medical History'], { textarea: true })}
    ${field('currentMedicines', 'Current Medicines', patient['Current Medicines'], { textarea: true })}
    ${field('notes', 'Additional Notes', patient['Notes'], { textarea: true })}

    <button type="submit" class="save-btn">Save / Update Profile</button>
  </form>
</div>
</body>
</html>`;
}

// Registers GET/POST /patient-profile/:token
function registerRoutes(app, ctx) {
  const { CLINIC_NAME_FALLBACK } = ctx;

  app.get('/patient-profile/:token', async (req, res) => {
    try {
      const patient = await validateToken(req.params.token);
      if (!patient) {
        return res
          .status(410)
          .send('Ha link ata valid nahi (expire zala asel). Kripaya clinic la sampark sadha navin link sathi.');
      }
      const settings = await sheets.getSettings();
      const html = buildProfilePageHtml({
        clinicName: settings.clinicName || CLINIC_NAME_FALLBACK,
        patient,
        saved: req.query.saved === '1',
      });
      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('patient-profile GET error:', err.message);
      res.status(500).send('Error loading profile: ' + err.message);
    }
  });

  app.post('/patient-profile/:token', async (req, res) => {
    try {
      const patient = await validateToken(req.params.token);
      if (!patient) {
        return res.status(410).send('Ha link ata valid nahi. Kripaya clinic la sampark sadha.');
      }
      const phone = sheets.stripQuote(patient['Phone Number']);
      const b = req.body || {};

      await sheets.updatePatientExtendedProfile(phone, {
        Name: b.fullName || patient['Name'],
        Age: b.age || patient['Age'],
        'Date of Birth': b.dob || '',
        Gender: b.gender || '',
        Address: b.address || '',
        City: b.city || '',
        'Blood Group': b.bloodGroup || '',
        Allergies: b.allergies || '',
        'Medical History': b.medicalHistory || '',
        'Current Medicines': b.currentMedicines || '',
        'Emergency Contact Name': b.emergencyName || '',
        'Emergency Contact Relation': b.emergencyRelation || '',
        'Emergency Contact Phone': b.emergencyPhone || '',
        Notes: b.notes || '',
        'Profile Completed': 'Yes',
      });

      res.redirect(`/patient-profile/${req.params.token}?saved=1`);
    } catch (err) {
      console.error('patient-profile POST error:', err.message);
      res.status(500).send('Error saving profile: ' + err.message);
    }
  });
}

module.exports = { createProfileLink, validateToken, registerRoutes };
