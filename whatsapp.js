// whatsapp.js
// Thin wrapper around Meta's WhatsApp Cloud API.
const axios = require('axios');
const FormData = require('form-data');
const QRCode = require('qrcode');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

// NOTE: base URL no longer ends in "/messages" like before — we now also
// need "/media" for uploads, so each call appends its own path.
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}`;

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  });
}

async function sendText(to, body) {
  await client().post(
    '/messages',
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// Sends a message with up to 3 quick-reply buttons.
// buttons: [{ id: 'today', title: 'Aaj' }, { id: 'tomorrow', title: 'Udya' }]
async function sendButtons(to, bodyText, buttons) {
  await client().post(
    '/messages',
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// Uploads a binary buffer (e.g. a QR code PNG we generated in memory) to
// Meta so it can be referenced by media id in a later /messages call.
// Images cannot be sent as raw bytes in the messages payload directly —
// Meta requires either a public URL or a media id obtained this way.
async function uploadMedia(buffer, mimeType = 'image/png') {
  const form = new FormData();
  form.append('file', buffer, { filename: 'upload.png', contentType: mimeType });
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);

  const res = await client().post('/media', form, { headers: form.getHeaders() });
  return res.data.id;
}

async function sendImageByMediaId(to, mediaId, caption) {
  await client().post(
    '/messages',
    {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: caption ? { id: mediaId, caption } : { id: mediaId },
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// Builds a UPI deep-link QR on the fly (amount baked in) and sends it.
// No QR image needs to be designed or hosted anywhere — it's regenerated
// per booking so the amount printed on it always matches the current fee.
async function sendUpiQr(to, { upiId, amount, clinicName, caption }) {
  const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(
    clinicName
  )}&am=${encodeURIComponent(amount)}&cu=INR`;
  const qrBuffer = await QRCode.toBuffer(upiLink, { width: 500 });
  const mediaId = await uploadMedia(qrBuffer, 'image/png');
  await sendImageByMediaId(to, mediaId, caption);
}

// Re-sends media the patient already sent us (e.g. a payment screenshot) to
// another number (staff/doctor). Media ids from an incoming message stay
// valid within the same WhatsApp Business Account for a while, so normally
// no re-upload is needed — only the recipient changes.
//
// FALLBACK: if this ever fails with a "media not found" style error, it
// means the id expired or isn't reusable in your account. In that case,
// first call GET /{media-id} (with the same auth header) to get a short-
// lived download URL, download the bytes, then call uploadMedia() on those
// bytes before sending — same two extra steps as sendUpiQr() above.
async function forwardImage(to, mediaId, caption) {
  await sendImageByMediaId(to, mediaId, caption);
}

// Extracts a normalized event from an incoming webhook POST body.
// Returns null if this payload isn't a patient message we care about
// (e.g. delivery/read status updates, which Meta also posts to the same webhook).
function parseIncomingMessage(webhookBody) {
  try {
    const entry = webhookBody.entry && webhookBody.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];
    if (!message) return null;

    const from = message.from; // patient's phone number, no "+"
    let text = null;
    let buttonId = null;
    let imageId = null;

    if (message.type === 'text') {
      text = message.text.body.trim();
    } else if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
      buttonId = message.interactive.button_reply.id;
      text = message.interactive.button_reply.title;
    } else if (message.type === 'image') {
      imageId = message.image.id;
    }

    return { from, text, buttonId, imageId, raw: message };
  } catch (err) {
    return null;
  }
}

module.exports = {
  sendText,
  sendButtons,
  sendUpiQr,
  forwardImage,
  parseIncomingMessage,
};
