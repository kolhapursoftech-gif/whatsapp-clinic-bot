# Clinic Bot — Upgrade Documentation

Existing WhatsApp booking flow, tech stack (Node + Express + Render + Google
Sheets + Google Drive + WhatsApp Cloud API) and files (`server.js`,
`sheets.js`, `whatsapp.js`, `messages.js`) are all **preserved** — nothing
was rewritten. Everything below is additive, wired in through `server.js`
with the smallest possible edits (see Section 7).

---

## 0. The Sheet now builds/updates itself — schema.js

You no longer need to manually add tabs or columns to the Google Sheet.
`schema.js` is the single source of truth for every tab and column the app
needs. Every time the server starts, it automatically:

- Creates any tab listed in `schema.js` that doesn't exist yet
- Adds any column listed that a tab is missing (always to the right of
  what's already there — existing columns/data are never touched)
- Adds default rows to `Settings` for any key that isn't there yet

**Adding a future feature that needs a new column or tab:** add it to the
`TAB_SCHEMAS` (or `SETTINGS_DEFAULTS`) list in `schema.js`, deploy, and
it's created automatically — no manual spreadsheet editing, ever.

To apply a schema change immediately without waiting for a restart, visit:
`https://your-app.onrender.com/admin/ensure-schema?secret=YOUR_SECRET`
— it returns a JSON summary of what it created/added (empty lists if the
sheet already matches). Safe to call any number of times.

---

## 1. Updated Project File Structure

```
whatsapp-clinic-bot/
├── server.js          (EXISTING — extended, not rewritten)
├── sheets.js           (EXISTING — extended, not rewritten)
├── whatsapp.js         (EXISTING — untouched)
├── messages.js         (EXISTING — 3 new message keys added per language)
├── package.json        (EXISTING — added "multer" dependency)
│
├── counters.js         (NEW) — all auto-numbering (Patient/Appointment/Case
│                         Paper/Record/Prescription/Daily Token IDs)
├── patients.js         (NEW) — patient domain logic (ID assignment, visit
│                         recording, search, timeline)
├── profile.js          (NEW) — secure patient self-service profile link
│                         + page (GET/POST /patient-profile/:token)
├── records.js          (NEW) — doctor's diagnosis/prescription persistence
│                         + patient medical history for the case paper
├── files.js            (NEW) — Google Drive upload/list/delete for patient
│                         documents (lab reports, X-rays, etc.)
├── queue.js            (NEW) — live token queue (check-in → call → consult
│                         → complete/skip/no-show) + WhatsApp queue alert
├── dashboard.js        (NEW) — Dashboard Home (stats), Patients list +
│                         search, Patient detail (digital file / timeline)
├── casepaper.js        (NEW) — upgraded case paper page (was inline in
│                         server.js): Case Paper Number, patient history
│                         panel, Save Diagnosis & Prescription
└── ui.js               (NEW) — shared HTML shell / nav / design tokens used
                          by dashboard.js, queue.js (keeps the new pages
                          visually consistent with each other)
└── schema.js           (NEW) — single source of truth for every tab/column
                          the app needs; auto-creates/extends the live
                          Google Sheet to match on every server startup
```

---

## 2. Purpose of Each New File

| File | Purpose |
|---|---|
| `counters.js` | Generates every auto-numbered ID (`PT-000001`, `APT-2026-000001`, `CP-2026-000001`, `REC-2026-000001`, `RX-2026-000001`, daily token `001/002/...`), reading/writing the `Counters` tab. Uses an in-process per-counter lock so two near-simultaneous bookings never get the same number (see the concurrency note inside the file). |
| `patients.js` | "What does it mean for a patient to..." — assigning a Patient ID on first booking, bumping visit counts, searching, and building the combined booking+record timeline for the dashboard. |
| `profile.js` | Generates the long random secure token sent to patients after booking, validates it (with expiry), and serves the self-service profile form (personal / emergency / medical info) — phone number and Patient ID never appear in the URL. |
| `records.js` | Saves a doctor's diagnosis, notes, and prescription against a booking (`Records` tab), auto-generates the Case Paper Number the first time a case paper is opened, and assembles a patient's medical history for display. |
| `files.js` | Uploads a file to Google Drive (via a service-account Drive client, separate scope from the Sheets client), stores metadata in the `Files` tab, and handles delete (both the Drive file and the metadata row). |
| `queue.js` | The live "who's next" queue for the day. Creates a Queue row automatically when a booking is confirmed; exposes staff actions (Check In / Call / Start / Complete / Skip / No-Show); renders the live queue page; sends the "your turn is coming up" WhatsApp alert. |
| `dashboard.js` | Three pages: `/dashboard/home` (today's stats + snapshots), `/patients` (searchable list), `/patients/:patientId` (complete digital file: personal info, medical info, timeline, files). |
| `casepaper.js` | Everything the old inline `/case-paper` route did, PLUS: Case Paper Number badge, a patient-history panel (allergies/history/current medicines/last 5 diagnoses), and a "Save Diagnosis & Prescription" button (`POST /case-paper/save`) that actually persists into `Records` instead of only living in the browser tab. |
| `ui.js` | One shared HTML page shell (nav bar + CSS variables) so `dashboard.js` and `queue.js` look like one product. `profile.js` and `casepaper.js` use their own standalone shells on purpose (they're patient-facing / print-facing pages, not staff nav pages). |
| `schema.js` | Defines every tab/column the app needs and auto-creates/extends the live Sheet to match — see Section 0 above. |

---

## 3. Google Sheets — Exact Tabs & Columns

**Header row text must match EXACTLY (including spaces/capitalisation)** —
every new function looks columns up by header name, not position, so you
can add these columns in any order / any position in each tab.

### Existing tabs — ADD these columns (append to the right of what's already there; don't reorder or delete existing columns)

**Bookings** — add:
```
Booking ID | Patient ID | Case Paper Number | Fee | Booking Status | Queue Status | Updated At
```
(`Booking Status` values: Confirmed / Consulted. `Queue Status` mirrors the Queue tab's Status for quick filtering on the Bookings tab itself.)

**Patients** — add:
```
Patient ID | Date of Birth | Gender | Address | City | Blood Group | Allergies |
Medical History | Current Medicines | Emergency Contact Name |
Emergency Contact Relation | Emergency Contact Phone | Profile Token |
Profile Token Expiry | Profile Completed | Total Visits | Notes | Created At | Updated At
```

### Brand-new tabs — create these with EXACTLY these headers in row 1

**Counters**
```
Counter Type | Current Value | Updated At
```

**Records**
```
Record ID | Patient ID | Booking ID | Case Paper Number | Date | Doctor Name |
Reason | Diagnosis | Doctor Notes | Prescription ID | Prescription Items | Created At
```
> `Prescription Items` is one column beyond the original spec — it stores the
> saved medicine rows (name/morning/evening/before-after-meal/days) as JSON
> text, so a saved prescription can be redisplayed later. Without it, a
> Prescription Number would exist with nothing behind it.

**Files**
```
File ID | Patient ID | Record ID | File Name | File Type |
Google Drive File ID | Google Drive URL | Uploaded By | Uploaded At
```

**Queue**
```
Date | Token Number | Booking ID | Patient ID | Status | Checked In At |
Called At | Started At | Completed At
```
(`Status` values: Waiting / Checked-In / Called / In-Consultation / Completed / Skipped / No-Show)

### Unchanged tabs
`Settings`, `Capacity`, `Pending`, `Medicines` — no changes needed.

---

## 4. Required Environment Variables

**Already existing (unchanged):**
```
GOOGLE_SHEET_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_PRIVATE_KEY
WHATSAPP_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_VERIFY_TOKEN
WHATSAPP_API_VERSION        (optional, defaults to v20.0)
TRIGGER_SECRET
DOCTOR_WHATSAPP_NUMBER
CLINIC_NAME
APP_BASE_URL                (or RENDER_EXTERNAL_URL, auto-set on Render)
PORT                        (Render sets this automatically)
```

**NEW — required for the new features:**
```
GOOGLE_DRIVE_FOLDER_ID      — a Drive folder shared with the service account
                              (Editor access) where patient files are stored.
PROFILE_LINK_VALID_DAYS     — optional, defaults to 30. How long a patient's
                              profile-completion link stays valid.
```

> **Google Cloud setup note:** the same service account used for Sheets now
> also needs the **Drive API enabled** in Google Cloud Console, and the
> target Drive folder shared with the service account's email address
> (Editor permission) — otherwise `files.js` uploads will fail.

---

## 5. Setup Instructions

1. **Update the Google Sheet** — add the new columns/tabs exactly as listed
   in Section 3. Do this BEFORE deploying the new code (old code keeps
   working regardless; new code degrades gracefully if a column is missing,
   but features depending on it — Patient ID, Queue, Case Paper Number,
   etc. — won't do anything until the columns exist).
2. **Enable the Drive API** for your Google Cloud project (same project as
   the Sheets API), and share a Drive folder with your service account
   email (Editor access). Copy that folder's ID into `GOOGLE_DRIVE_FOLDER_ID`.
3. **Add the new environment variables** (Section 4) in Render's dashboard.
4. **Deploy** — `npm install` will now also pull in `multer` (added to
   `package.json`).
5. Existing `/admin/generate-slots` and the WhatsApp webhook keep working
   exactly as before — no re-setup needed there.
6. New pages to bookmark for staff:
   - `https://your-app.onrender.com/dashboard/home?secret=YOUR_SECRET`
   - `https://your-app.onrender.com/patients?secret=YOUR_SECRET`
   - `https://your-app.onrender.com/queue?secret=YOUR_SECRET`
   - `/dashboard` (existing per-day view) now also links to all three above.

---

## 6. Testing Checklist

**Regression (existing flow — do these FIRST, before trusting anything new):**
- [ ] New patient sends "Hi" → language picker → name → age → reason → date → slot → payment/free flow → staff Confirm → booking-confirmed WhatsApp message arrives with the right token/date/time.
- [ ] Returning patient sends "Hi" → recognized, skips straight to "same person / someone else?".
- [ ] `/admin/generate-slots?secret=...` still generates the next 7 days without duplicates.
- [ ] `/dashboard?secret=...&date=YYYY-MM-DD` still shows that day's bookings table exactly as before.
- [ ] Staff `CONFIRM 1234` text command still works alongside the button flow.

**New features:**
- [ ] After a booking is confirmed, check the `Bookings` row has a `Booking ID`, `Patient ID`, and `Fee` filled in.
- [ ] Same phone number booking twice reuses the same `Patient ID` (doesn't generate a new one).
- [ ] Patient receives the secure profile link message; opening it shows a pre-filled form; saving shows "Tumchi mahiti yashasviritya update zali aahe."; a second visit to the same link shows the saved values.
- [ ] An expired/garbage token on `/patient-profile/:token` returns the "link no longer valid" message, not a crash.
- [ ] `/dashboard/home?secret=...` shows correct counts (Total/New/Follow-up/Waiting/Completed/Payment Pending/Paid Amount/Free/No-Show) matching today's actual bookings.
- [ ] `/patients?secret=...&q=<name or phone or Patient ID>` finds the right patient.
- [ ] `/patients/<Patient ID>?secret=...` shows personal info, medical info, a timeline with the booking(s), and an upload box.
- [ ] Uploading a file from a patient's detail page appears in Google Drive AND in the `Files` tab; "Open" opens it; "Delete" removes both the Drive file and the row.
- [ ] `/queue?secret=...` shows today's tokens; Check In → Call → Start Consultation → Complete moves a row through every stage; the "few tokens ahead" WhatsApp alert fires to the right patient when Call is pressed.
- [ ] Opening `/case-paper?...` for a NEW-format booking shows a Case Paper Number badge and a history panel (if the patient has any); "Save Diagnosis & Prescription" persists and reappears if you reopen the same case paper.
- [ ] Opening `/case-paper?...` for an OLD booking (made before this upgrade, no Booking ID) still opens correctly — just without the CP-number badge/save button data (since it has nothing to key off of).

---

## 7. Summary of What Changed in Existing Features

- **Multiple patients per phone number** — a family sharing one WhatsApp
  number and booking for different members now gets a **separate Patient
  ID/file per member**, matched on (Phone Number, Name) instead of phone
  alone. This touches `ensurePatientId`, `upsertPatientProfile`, the
  extended-profile functions (`getPatientProfileByPhoneAndName`,
  `updatePatientExtendedProfile`, `incrementPatientVisitCount`,
  `setProfileToken`), and their callers in `patients.js`, `records.js`,
  `profile.js`, and `finalizeBooking()`. The phone-only lookup
  (`getPatientProfile`/`getPatientFullProfile`) is kept ONLY for things
  that are genuinely phone-wide, not person-specific (preferred language,
  "is this a returning number" greeting check).
- **Profile link sent once per patient** — `finalizeBooking()` now checks
  whether this specific family member's `Profile Completed` is already
  `Yes` before generating/sending a new secure link. A second, third, etc.
  booking for someone who already filled it in no longer gets pinged
  again.
- **Case paper page now has the staff nav bar** — the same
  Dashboard/Appointments/Patients/Live Queue links shown on the dashboard
  pages now appear at the top of the case paper too (hidden when printing),
  so staff aren't dropped on a dead-end page after opening it from
  WhatsApp.

- **`finalizeBooking()`** (in `server.js`) — same booking-confirmed message
  and staff notification as before, PLUS: assigns/reuses a Patient ID,
  generates a Booking ID, records the Fee amount, creates today's Queue
  entry, bumps the patient's visit count, and sends the secure
  profile-completion link. If `APP_BASE_URL` isn't set, the profile-link
  step is skipped (booking still completes normally).
- **`appendBooking()`** in `sheets.js` is UNTOUCHED and still exported —
  `finalizeBooking` now calls a new function, `appendBookingRow()`, instead,
  which writes by header name so it can populate the new columns on the
  same row. If your Sheet's `Bookings` header doesn't have the new columns
  yet, those fields are silently skipped and the original 10 columns are
  written exactly as before — nothing breaks either way.
- **`/case-paper`** — same URL/query-param shape, upgraded content (see
  Section 2). The inline `buildCasePaperHtml()`/route in `server.js` was
  removed and now lives in `casepaper.js`.
- **`/dashboard`** (existing per-day bookings table) — untouched, with one
  visual-only addition: three small nav links at the top ("🏠 Dashboard
  Home", "🧑‍🤝‍🧑 Patients", "⏱️ Live Queue") pointing to the new pages.
- **`messages.js`** — 3 new message keys added per language
  (`profileLinkMessage`, `queueAlert`); all existing keys unchanged.
- **`package.json`** — added `multer` as a dependency (file uploads).
- Everything else (webhook verification, slot generation, staff CONFIRM/
  HOLD/REJECT text commands, missed-call trigger) is byte-for-byte
  unchanged.
