// groq.js
// The booking flow itself (name -> age -> date buttons -> token) is handled
// as a plain state machine in server.js, on purpose: for something as
// important as an appointment, deterministic parsing is more reliable than
// asking an LLM to extract structured fields every turn. Groq is used only
// as a fallback: if a patient sends something unexpected mid-flow ("what
// are your clinic timings?", "can I bring my mother too?"), we ask Groq for
// a short, friendly reply that gently steers them back to the current step.

const axios = require('axios');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const CLINIC_NAME = process.env.CLINIC_NAME || 'the clinic';

async function getFallbackReply(patientMessage, currentStep) {
  if (!GROQ_API_KEY) {
    return "Sorry, could you reply with just the info I asked for? Let's continue with your booking.";
  }

  const stepHints = {
    ASK_NAME: 'You just asked the patient for their full name.',
    ASK_AGE: "You just asked the patient for their age.",
    ASK_DATE: 'You just asked the patient to pick "Aaj" (today) or "Udya" (tomorrow) using the buttons.',
  };

  const systemPrompt = `You are a WhatsApp receptionist assistant for ${CLINIC_NAME}. ` +
    `A patient sent a message that isn't a direct answer to what you asked. ` +
    `${stepHints[currentStep] || ''} ` +
    `Reply in at most 2 short sentences, warm and simple, in the same mix of Hindi/Marathi/English the ` +
    `patient used if any, and gently redirect them back to answering that question. Do not invent clinic ` +
    `hours, prices, or medical advice.`;

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: patientMessage },
        ],
        max_tokens: 150,
        temperature: 0.4,
      },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } }
    );
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    return "Sorry, could you reply with just the info I asked for? Let's continue with your booking.";
  }
}

module.exports = { getFallbackReply };
