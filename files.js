// files.js
// Patient document uploads (lab reports, X-rays, scanned documents...).
// Actual bytes go to Google Drive; only metadata (name, type, Drive file
// id/URL) is stored in the Files tab of the same Google Sheet — per the
// "Google Sheets stays the database, Drive is only file storage" rule.
//
// Needs its own Google auth client (Drive scope) separate from sheets.js's
// Sheets-scoped client — same service account, different scope.

const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');
const sheets = require('./sheets');
const counters = require('./counters');

const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID; // shared with the service account, Editor access

let driveClientPromise = null;
function getDriveClient() {
  if (!driveClientPromise) {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    driveClientPromise = auth.authorize().then(() => google.drive({ version: 'v3', auth }));
  }
  return driveClientPromise;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function uploadToDrive({ buffer, fileName, mimeType }) {
  const drive = await getDriveClient();
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined,
    },
    media: { mimeType, body: bufferStream },
    fields: 'id, webViewLink, webContentLink',
  });

  // Service-account-owned files are private by default — make them
  // viewable via link so staff can open them straight from the dashboard
  // without a separate Google login prompt.
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const fresh = await drive.files.get({ fileId: res.data.id, fields: 'id, webViewLink' });
  return { driveFileId: res.data.id, url: fresh.data.webViewLink };
}

async function deleteFromDrive(driveFileId) {
  const drive = await getDriveClient();
  await drive.files.delete({ fileId: driveFileId }).catch((err) => {
    // If it's already gone from Drive, don't block removing the metadata row.
    console.warn('Drive delete warning:', err.message);
  });
}

async function saveFileForPatient({ patientId, recordId, fileBuffer, fileName, mimeType, uploadedBy }) {
  const { driveFileId, url } = await uploadToDrive({ buffer: fileBuffer, fileName, mimeType });
  const fileId = await counters.nextFileId();
  await sheets.appendFileMeta({
    'File ID': fileId,
    'Patient ID': patientId,
    'Record ID': recordId || '',
    'File Name': fileName,
    'File Type': mimeType,
    'Google Drive File ID': driveFileId,
    'Google Drive URL': url,
    'Uploaded By': uploadedBy || 'Staff',
    'Uploaded At': new Date().toISOString(),
  });
  return { fileId, url };
}

async function removeFile(fileId) {
  const meta = await sheets.getFileById(fileId);
  if (!meta) return false;
  if (meta['Google Drive File ID']) await deleteFromDrive(meta['Google Drive File ID']);
  await sheets.deleteFileMeta(fileId);
  return true;
}

// Registers the upload/delete endpoints. Listing is done directly via
// sheets.getFilesForPatient() from dashboard.js's patient-detail page —
// no separate "list" route needed.
function registerRoutes(app, ctx) {
  const { TRIGGER_SECRET } = ctx;

  app.post('/patients/:patientId/files', upload.single('file'), async (req, res) => {
    if (req.query.secret !== TRIGGER_SECRET) return res.sendStatus(401);
    if (!req.file) return res.status(400).send('No file uploaded (field name must be "file").');
    try {
      await saveFileForPatient({
        patientId: req.params.patientId,
        fileBuffer: req.file.buffer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        uploadedBy: req.query.uploadedBy || 'Staff',
      });
      res.redirect(`/patients/${req.params.patientId}?secret=${encodeURIComponent(TRIGGER_SECRET)}`);
    } catch (err) {
      console.error('file upload error:', err.message);
      res.status(500).send('Upload failed: ' + err.message);
    }
  });

  app.post('/files/:fileId/delete', async (req, res) => {
    if (req.query.secret !== TRIGGER_SECRET) return res.sendStatus(401);
    try {
      const meta = await sheets.getFileById(req.params.fileId);
      await removeFile(req.params.fileId);
      const redirectPatientId = meta ? meta['Patient ID'] : '';
      res.redirect(`/patients/${redirectPatientId}?secret=${encodeURIComponent(TRIGGER_SECRET)}`);
    } catch (err) {
      console.error('file delete error:', err.message);
      res.status(500).send('Delete failed: ' + err.message);
    }
  });
}

module.exports = { saveFileForPatient, removeFile, registerRoutes };
