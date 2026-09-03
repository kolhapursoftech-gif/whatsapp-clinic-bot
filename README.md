# WhatsApp AI Receptionist — Setup

## 1. Google Sheet

Create a new Google Sheet with **three tabs**, exact names and headers below (row 1 = headers).

**Capacity**
| Date | Capacity |
|---|---|
| Default | 15 |

Add a `Default` row so booking works even before the doctor sets specific dates. You can also add rows for a specific date (e.g. `2026-09-05`) to override the default for that day.

**Bookings** *(leave empty — the bot fills this in)*
| Timestamp | Name | Age | Date | Token | Phone |
|---|---|---|---|---|---|

**Pending** *(leave empty — the bot fills this in)*
| Phone | Step | Name | Age | UpdatedAt |
|---|---|---|---|---|

Copy the Sheet ID from its URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

### Service account
1. Google Cloud Console → new project → enable **Google Sheets API**
2. Create a **Service Account** → create a key (JSON) → download it
3. Open the JSON: copy `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`, copy `private_key` → `GOOGLE_PRIVATE_KEY`
4. **Share the Sheet** with that `client_email` address, giving it Editor access — this step is easy to miss and the #1 cause of a "permission denied" error

## 2. Meta WhatsApp Cloud API
1. developers.facebook.com → create an App (Business type) → add the **WhatsApp** product
2. Note the **Phone Number ID** and generate a temporary (or permanent, via a system user) **Access Token**
3. Under WhatsApp → Configuration, set the webhook URL to `https://YOUR-RENDER-URL/webhook` and the **Verify Token** to any string you choose — put the same string in `.env` as `WHATSAPP_VERIFY_TOKEN`
4. Subscribe the webhook to the `messages` field

## 3. Groq (optional but recommended)
console.groq.com → sign up → create an API key. Free, no card required. Without a key, the bot still works — it just uses a generic fallback line instead of an AI-generated one when a patient goes off-script.

## 4. Deploy to Render.com
1. Push this folder to a GitHub repo
2. Render.com → New → Web Service → connect the repo
3. Build command: `npm install` · Start command: `npm start`
4. Add every variable from `.env.example` under Render's **Environment** tab (don't upload `.env` itself)
5. Deploy — Render gives you a public URL; use it as the WhatsApp webhook URL above

## 5. Missed-call trigger
The bot exposes a generic endpoint for this — wire up whatever missed-call/call-forwarding service you use to `POST` here when a call goes unanswered:

```
POST https://YOUR-RENDER-URL/trigger-missed-call?secret=YOUR_TRIGGER_SECRET
Content-Type: application/json

{ "phone": "91XXXXXXXXXX" }
```

That's all it needs — the trigger service doesn't need to know anything about WhatsApp or Sheets, just the caller's number.

## 6. Test end-to-end
- `curl -X POST ".../trigger-missed-call?secret=..." -H "Content-Type: application/json" -d '{"phone":"91XXXXXXXXXX"}'` — confirm the greeting arrives on that WhatsApp number
- Reply with a name, then an age, then tap a date button — confirm the booking arrives in the **Bookings** tab and the doctor gets notified
- Set `Capacity` to `1` for a test date, book it, then try booking again — confirm the "full" message and the automatic next-day offer

## Notes
- All text sent to patients is a simple Romanized Marathi/Hindi mix — edit the strings directly in `server.js` to match your clinic's preferred phrasing or language.
- The booking flow (name → age → date buttons) is deterministic, not AI-generated, so it can't mis-parse a booking. Groq only handles the "patient said something unexpected" case.
- State for an in-progress conversation lives in the **Pending** tab, not server memory, so it survives Render's free-tier spin-down/restarts.
