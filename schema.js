// schema.js
// SINGLE SOURCE OF TRUTH for the Google Sheet's structure.
//
// Whenever a future feature needs a new tab or a new column, add it HERE —
// nowhere else — and it will be created automatically on the sheet the
// next time the server starts (or immediately via GET
// /admin/ensure-schema?secret=...). No more opening the Google Sheet and
// typing column headers by hand.
//
// Rules this file follows so it's always safe to run, any time, as often
// as you like:
//   - A tab that already exists is never deleted or renamed.
//   - A column that already exists is never touched, moved, or removed —
//     new columns are only ever added to the right of what's there.
//   - Existing DATA is never modified. This only ever adds structure.
//
// If you rename a header here, the OLD header is treated as still
// missing and a new column is added for the new name — it does not
// rename the existing one (renaming could silently disconnect the app
// from data staff have already been using under the old name). Rename
// deliberately in the Sheet by hand if you really mean it.

const sheets = require('./sheets');

// Tabs where row 1 is a real header row that the rest of the app looks
// columns up by name in (this is most of the sheet).
const TAB_SCHEMAS = [
  { name: 'Capacity', headers: ['Date', 'Slot', 'Max Capacity', 'Booked Count'] },

  {
    name: 'Bookings',
    headers: [
      'Timestamp', 'Phone Number', 'Name', 'Age', 'Reason', 'Date', 'Slot', 'Token Number',
      'Payment Status', 'Visit Type',
      // Added for the dashboard/queue/case-paper/patient-history upgrade:
      'Booking ID', 'Patient ID', 'Case Paper Number', 'Fee', 'Booking Status', 'Queue Status', 'Updated At',
      // Added for multi-doctor + reminders:
      'Doctor ID', 'Reminder Sent',
    ],
  },

  { name: 'Pending', headers: ['Phone Number', 'Step', 'Name', 'Age', 'Reason', 'Date', 'Slot', 'Lang', 'Timestamp'] },

  {
    name: 'Patients',
    headers: [
      'Phone Number', 'Name', 'Age', 'Lang', 'Last Visit Date',
      // Added for the extended patient profile:
      'Patient ID', 'Date of Birth', 'Gender', 'Address', 'City', 'Blood Group', 'Allergies',
      'Medical History', 'Current Medicines', 'Emergency Contact Name', 'Emergency Contact Relation',
      'Emergency Contact Phone', 'Profile Token', 'Profile Token Expiry', 'Profile Completed',
      'Total Visits', 'Notes', 'Created At', 'Updated At',
    ],
  },

  { name: 'Medicines', headers: ['Medicine Name', 'Morning', 'Evening', 'Before Meal', 'After Meal'] },
  { name: 'Counters', headers: ['Counter Type', 'Current Value', 'Updated At'] },

  {
    name: 'Records',
    headers: [
      'Record ID', 'Patient ID', 'Booking ID', 'Case Paper Number', 'Date', 'Doctor Name', 'Reason',
      'Diagnosis', 'Doctor Notes', 'Prescription ID', 'Prescription Items', 'Created At',
      'Doctor ID',
    ],
  },

  {
    name: 'Files',
    headers: [
      'File ID', 'Patient ID', 'Record ID', 'File Name', 'File Type',
      'Google Drive File ID', 'Google Drive URL', 'Uploaded By', 'Uploaded At',
    ],
  },

  {
    name: 'Queue',
    headers: [
      'Date', 'Token Number', 'Booking ID', 'Patient ID', 'Status',
      'Checked In At', 'Called At', 'Started At', 'Completed At',
    ],
  },

  // ---- Billing ----
  {
    name: 'Expenses',
    headers: ['Expense ID', 'Date', 'Category', 'Description', 'Amount', 'Paid By', 'Created At'],
  },

  // ---- Multi-doctor ----
  {
    name: 'Doctors',
    headers: ['Doctor ID', 'Name', 'Specialization', 'WhatsApp Number', 'Active', 'Created At'],
  },

  // ---- Staff login / roles ----
  {
    name: 'Staff',
    headers: ['Staff ID', 'Name', 'Role', 'PIN', 'Active', 'Created At'],
  },
];

// Settings is Key/Value pairs, not a header-lookup tab — getSettings()
// reads row 1 as a header (skipped) and every row after as one setting.
// So this only needs a header row on first creation, plus: any default
// key below that doesn't already exist anywhere in the tab gets added as
// a new row (so a fresh clinic gets sane defaults, and an upgraded clinic
// gets any brand-new setting a later feature introduces).
const SETTINGS_HEADER = ['Setting Name', 'Value'];
const SETTINGS_DEFAULTS = [
  ['Clinic Name', 'My Clinic'],
  ['Clinic Address', ''],
  ['Clinic Phone', ''],
  ['Doctor Name', ''],
  ['New Patient Fee', '0'],
  ['Follow-up Fee', '0'],
  ['UPI ID', ''],
  ['Case Paper Validity Days', '30'],
  ['Minimum Notice Minutes', '30'],
  ['Queue Alert Minutes', '2'],
  ['Default Language', 'mr'],
  ['Morning Start', '10:00 AM'],
  ['Morning End', '1:00 PM'],
  ['Evening Start', '5:00 PM'],
  ['Evening End', '9:00 PM'],
  ['Slot Duration Minutes', '15'],
  ['Max Capacity Per Slot', '1'],
  ['Days To Generate Ahead', '7'],
  ['Staff WhatsApp Number', ''],
  // Reminders
  ['Reminder Hours Before', '2'],
  // Multi-doctor (single-doctor clinics can leave this blank — see doctors.js)
  ['Enable Multi-Doctor', 'No'],
  // Staff login (super-admin PIN — separate from individual staff PINs in the Staff tab)
  ['Admin PIN', ''],
];

// Creates any missing tab, adds any missing column to every tab, and tops
// up any missing Settings default. Safe to call on every server startup
// and any number of times by hand — it only ever adds, never removes or
// overwrites. Returns a summary object for logging.
async function ensureSheetSchema() {
  const existingTabs = await sheets.listTabNames();
  const report = { tabsCreated: [], columnsAdded: {}, settingsAdded: [] };

  for (const { name, headers } of TAB_SCHEMAS) {
    if (!existingTabs.includes(name)) {
      await sheets.createTab(name);
      report.tabsCreated.push(name);
    }
    const { added } = await sheets.ensureHeaderColumns(name, headers);
    if (added.length) report.columnsAdded[name] = added;
  }

  // Settings: create the tab (with just its header row) if entirely
  // missing, then top up any default key that isn't present yet.
  if (!existingTabs.includes('Settings')) {
    await sheets.createTab('Settings');
    report.tabsCreated.push('Settings');
  }
  const { header: settingsHeader } = await sheets.readTab('Settings');
  if (settingsHeader.length === 0) {
    await sheets.ensureHeaderColumns('Settings', SETTINGS_HEADER);
  }
  const { rows: settingsRows } = await sheets.readTab('Settings');
  const existingKeys = new Set(settingsRows.map((r) => (r[0] || '').trim()).filter(Boolean));
  for (const [key, defaultValue] of SETTINGS_DEFAULTS) {
    if (!existingKeys.has(key)) {
      await sheets.setSettingValue(key, defaultValue);
      report.settingsAdded.push(key);
    }
  }

  return report;
}

module.exports = { ensureSheetSchema, TAB_SCHEMAS, SETTINGS_DEFAULTS };
