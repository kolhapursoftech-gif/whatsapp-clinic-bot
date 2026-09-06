// messages.js
// Small localization layer for patient-facing bot text.
//
// Staff-facing messages (screenshot forward captions, CONFIRM replies) are
// NOT localized — they always go to one fixed operator, so a single
// language is simpler and avoids surprises for whoever is running the desk.
//
// Formatting note: WhatsApp renders *text* as bold and _text_ as italic in
// regular messages — but NOT inside button/list titles, where markdown
// shows up as literal asterisks. So bold/italic is used only in body text
// below, never inside dateButtons/LANGUAGE_BUTTONS titles.

const LANGUAGE_BUTTONS = [
  { id: 'lang_mr', title: '💬 मराठी' },
  { id: 'lang_hi', title: '💬 हिंदी' },
  { id: 'lang_en', title: '💬 English' },
];

// Shown before we know which language the patient wants, so it's written
// once in all three so everyone understands it regardless of preference.
const LANGUAGE_PROMPT =
  '👋 Namaskar / नमस्ते / Hello!\nKripaya bhasha nivda / Kripya bhasha chunein / Please choose your language:';

const TEMPLATES = {
  mr: {
    invalidName: '❗ Kripaya barobar naav sanga (kimman 2 akshar).',
    welcomeAskName: (clinic) =>
      `👋 *Namaskar!*\n*${clinic}* madhe swagat aahe.\n\nAppointment book karayla, kripaya tumche *purna naav* sanga.`,
    askAge: (name) => `Dhanyawad, *${name}*! 🙏\nAata tumche *vay (age)* sanga.`,
    invalidAge: '❗ Kripaya barobar vay (number madhe) sanga.',
    askDateBody: '📅 Appointment kevha havi aahe?',
    dateButtons: [
      { id: 'today', title: '📅 Aaj' },
      { id: 'tomorrow', title: '➡️ Udya' },
    ],
    askDateRetry: 'Kripaya button dabun date select kara.',
    dayFull: '😔 Kshama kara, ya divashi ekahi vel shillak nahi. Kripaya doosra divas nivda.',
    allFull: '😔 Kshama kara, Aaj ani Udya donhi divas full aahet. Kripaya nantar sampark sadha.',
    askSlotBody: (dateStr) => `🕒 *${dateStr}* sathi khali dilelya velapatrakatun ek vel nivda:`,
    askSlotButtonLabel: 'Vel nivda',
    slotsLeftLabel: 'shillak',
    noSlots: '😔 Kshama kara, ya divashi ekahi vel shillak nahi. Kripaya doosra divas nivda.',
    paymentCaption: (fee, upiId, clinic) =>
      `🧾 *${clinic}*\n\n💳 Appointment Fee: *Rs ${fee}*\nUPI ID: *${upiId}*\n\nQR scan karun payment kara, ani payment cha *screenshot* ithech pathva.`,
    screenshotReceived: '✅ Dhanyawad! Tumcha payment screenshot milala.\nStaff verify karat aahet, kripaya thoda vel thamba.',
    askForScreenshot: '📸 Kripaya payment cha screenshot (photo) pathva.',
    stillWaiting: '⏳ Amhi tumcha payment verify karat aahot. Kripaya thoda vel thamba, confirmation lavkarach yeil.',
    bookingConfirmed: (clinic, name, token, dateStr, slotLabel) =>
      `✅ *${clinic}*\n*Booking Confirm Zali!*\n\n👤 Naav: *${name}*\n🎟️ Token Number: *${token}*\n📅 Date: *${dateStr}*\n🕒 Vel: *${slotLabel}*\n\nKripaya tumcha token number sobat ghevun ya.`,
    slotNowFull: '😔 Kshama kara, tumchi nivadleli vel ata full zali aahe. Kripaya doctor shi sampark sadha.',
  },

  hi: {
    invalidName: '❗ Kripya sahi naam bataiye (kam se kam 2 akshar).',
    welcomeAskName: (clinic) =>
      `👋 *Namaste!*\n*${clinic}* mein aapka swagat hai.\n\nAppointment book karne ke liye, kripya apna *poora naam* bataiye.`,
    askAge: (name) => `Dhanyawad, *${name}*! 🙏\nAb apni *umar (age)* bataiye.`,
    invalidAge: '❗ Kripya sahi umar (number mein) bataiye.',
    askDateBody: '📅 Appointment kab chahiye?',
    dateButtons: [
      { id: 'today', title: '📅 Aaj' },
      { id: 'tomorrow', title: '➡️ Kal' },
    ],
    askDateRetry: 'Kripya button dabakar date chunein.',
    dayFull: '😔 Maaf kijiye, is din koi samay khali nahi hai. Kripya doosra din chunein.',
    allFull: '😔 Maaf kijiye, Aaj aur Kal dono din full hain. Kripya baad mein sampark karein.',
    askSlotBody: (dateStr) => `🕒 *${dateStr}* ke liye neeche di gayi list se ek samay chunein:`,
    askSlotButtonLabel: 'Samay chunein',
    slotsLeftLabel: 'bache hain',
    noSlots: '😔 Maaf kijiye, is din koi samay khali nahi hai. Kripya doosra din chunein.',
    paymentCaption: (fee, upiId, clinic) =>
      `🧾 *${clinic}*\n\n💳 Appointment Fee: *Rs ${fee}*\nUPI ID: *${upiId}*\n\nQR scan karke payment karein, aur payment ka *screenshot* yahin bhejein.`,
    screenshotReceived: '✅ Dhanyawad! Aapka payment screenshot mil gaya.\nStaff verify kar rahe hain, kripya thoda intezaar karein.',
    askForScreenshot: '📸 Kripya payment ka screenshot (photo) bhejein.',
    stillWaiting: '⏳ Hum aapka payment verify kar rahe hain. Kripya thoda intezaar karein, confirmation jald aayega.',
    bookingConfirmed: (clinic, name, token, dateStr, slotLabel) =>
      `✅ *${clinic}*\n*Booking Confirm Ho Gayi!*\n\n👤 Naam: *${name}*\n🎟️ Token Number: *${token}*\n📅 Date: *${dateStr}*\n🕒 Samay: *${slotLabel}*\n\nKripya apna token number saath layein.`,
    slotNowFull: '😔 Maaf kijiye, aapka chuna hua samay ab full ho gaya hai. Kripya doctor se sampark karein.',
  },

  en: {
    invalidName: '❗ Please enter a valid name (at least 2 letters).',
    welcomeAskName: (clinic) =>
      `👋 *Hello!*\nWelcome to *${clinic}*.\n\nTo book an appointment, please tell us your *full name*.`,
    askAge: (name) => `Thank you, *${name}*! 🙏\nNow please tell us your *age*.`,
    invalidAge: '❗ Please enter a valid age (a number).',
    askDateBody: '📅 When would you like your appointment?',
    dateButtons: [
      { id: 'today', title: '📅 Today' },
      { id: 'tomorrow', title: '➡️ Tomorrow' },
    ],
    askDateRetry: 'Please tap a button to select the date.',
    dayFull: '😔 Sorry, no slots are left for this day. Please choose another day.',
    allFull: '😔 Sorry, both Today and Tomorrow are fully booked. Please contact us later.',
    askSlotBody: (dateStr) => `🕒 Please choose a time slot for *${dateStr}*:`,
    askSlotButtonLabel: 'Choose time',
    slotsLeftLabel: 'left',
    noSlots: '😔 Sorry, no slots are left for this day. Please choose another day.',
    paymentCaption: (fee, upiId, clinic) =>
      `🧾 *${clinic}*\n\n💳 Appointment Fee: *Rs ${fee}*\nUPI ID: *${upiId}*\n\nScan the QR to pay, and send the payment *screenshot* here.`,
    screenshotReceived: '✅ Thank you! We received your payment screenshot.\nOur staff is verifying it, please wait a moment.',
    askForScreenshot: '📸 Please send a screenshot (photo) of your payment.',
    stillWaiting: "⏳ We're still verifying your payment. Please wait a bit, confirmation will arrive soon.",
    bookingConfirmed: (clinic, name, token, dateStr, slotLabel) =>
      `✅ *${clinic}*\n*Booking Confirmed!*\n\n👤 Name: *${name}*\n🎟️ Token Number: *${token}*\n📅 Date: *${dateStr}*\n🕒 Time: *${slotLabel}*\n\nPlease bring your token number with you.`,
    slotNowFull: '😔 Sorry, your chosen time slot just got fully booked. Please contact the doctor.',
  },
};

function getMessages(lang) {
  return TEMPLATES[lang] || TEMPLATES.mr;
}

module.exports = { getMessages, LANGUAGE_BUTTONS, LANGUAGE_PROMPT };
