// schema.js
// Sets up the Google Sheet for you. On every server start it:
//   - creates any tab that is missing
//   - adds any column that is missing (always to the RIGHT of what is there)
//   - adds default rows to "Settings" for keys that are missing
//   - creates the "Today" tab (a formula tab that lists only today's bookings)
//
// It NEVER deletes or renames a tab/column and NEVER changes existing data,
// so it is safe to run any number of times.
//
// To apply a change immediately (without a restart) open:
//   https://your-app.onrender.com/admin/ensure-schema?secret=YOUR_SECRET

const sheets = require('./sheets');

const TAB_SCHEMAS = [
  { name: 'Capacity', headers: ['Date', 'Slot', 'Max Capacity', 'Booked Count'] },

  {
    name: 'Bookings',
    headers: [
      'Timestamp', 'Phone Number', 'Name', 'Age', 'Reason', 'Date', 'Slot', 'Token Number',
      'Payment Status', 'Fee', 'Booking Status',
    ],
  },

  { name: 'Pending', headers: ['Phone Number', 'Step', 'Name', 'Age', 'Reason', 'Date', 'Slot', 'Lang', 'Timestamp'] },

  { name: 'Patients', headers: ['Phone Number', 'Name', 'Age', 'Lang', 'Last Visit Date'] },
];

const SETTINGS_HEADER = ['Setting Name', 'Value'];
const SETTINGS_DEFAULTS = [
  ['Clinic Name', 'My Clinic'],
  ['Appointment Fee', '0'], // skipped if an older "New Patient Fee" row already exists (see below)
  ['UPI ID', ''],
  ['Staff WhatsApp Number', ''],
  ['Alert WhatsApp Number', ''],
  ['Default Language', 'mr'],
  ['Morning Start', '10:00 AM'],
  ['Morning End', '1:00 PM'],
  ['Evening Start', '5:00 PM'],
  ['Evening End', '9:00 PM'],
  ['Slot Duration Minutes', '15'],
  ['Max Capacity Per Slot', '1'],
  ['Days To Generate Ahead', '7'],
  ['Minimum Notice Minutes', '30'],
];

// "Today" tab: row 1 copies the Bookings headers, A2 is a FILTER formula that
// shows only the bookings whose Date is today. Created once; never overwritten.
// (Uses the Sheet's own timezone for TODAY() - set it to India in
// File > Settings > Time zone.)
async function ensureTodayTab(existingTabs, report) {
  if (existingTabs.includes('Today')) return;

  // Find the Date and Booking Status columns BY HEADER NAME, so this works
  // on an old Sheet where Bookings has extra columns in a different order.
  const { header } = await sheets.readTab('Bookings');
  const dateIdx = header.indexOf('Date');
  const statusIdx = header.indexOf('Booking Status');
  if (dateIdx === -1) throw new Error('Bookings tab has no "Date" column yet');
  const dateCol = sheets.colLetter(dateIdx + 1);
  const lastCol = sheets.colLetter(Math.max(header.length, 1));

  await sheets.createTab('Today');
  report.tabsCreated.push('Today');
  await sheets.updateRow('Today', 1, [`={Bookings!A1:${lastCol}1}`]);

  const conditions = [`Bookings!${dateCol}2:${dateCol}=TEXT(TODAY(),"yyyy-mm-dd")`];
  if (statusIdx !== -1) {
    const statusCol = sheets.colLetter(statusIdx + 1);
    conditions.push(`Bookings!${statusCol}2:${statusCol}<>"Cancelled"`);
  }
  await sheets.updateRow('Today', 2, [
    `=IFERROR(FILTER(Bookings!A2:${lastCol}, ${conditions.join(', ')}),"Aaj koi booking nahi")`,
  ]);
}

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
    // An older Sheet has "New Patient Fee" - don't add "Appointment Fee = 0"
    // next to it, or the fee would silently become free.
    if (key === 'Appointment Fee' && existingKeys.has('New Patient Fee')) continue;
    if (!existingKeys.has(key)) {
      await sheets.setSettingValue(key, defaultValue);
      report.settingsAdded.push(key);
    }
  }

  // Non-fatal: a problem here must never stop the bot from booking patients.
  try {
    await ensureTodayTab(existingTabs, report);
  } catch (err) {
    console.error('[schema] Could not create "Today" tab (non-fatal):', err.message);
  }

  return report;
}

module.exports = { ensureSheetSchema, TAB_SCHEMAS, SETTINGS_DEFAULTS };
