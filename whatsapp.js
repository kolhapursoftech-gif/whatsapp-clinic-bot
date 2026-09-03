// whatsapp.js
// Thin wrapper around Meta's WhatsApp Cloud API.

const axios = require('axios');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

async function sendText(to, body) {
  await client().post('', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

// Sends a message with up to 3 quick-reply buttons.
// buttons: [{ id: 'today', title: 'Aaj' }, { id: 'tomorrow', title: 'Udya' }]
async function sendButtons(to, bodyText, buttons) {
  await client().post('', {
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
  });
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

    if (message.type === 'text') {
      text = message.text.body.trim();
    } else if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
      buttonId = message.interactive.button_reply.id;
      text = message.interactive.button_reply.title;
    }

    return { from, text, buttonId, raw: message };
  } catch (err) {
    return null;
  }
}

module.exports = { sendText, sendButtons, parseIncomingMessage };
