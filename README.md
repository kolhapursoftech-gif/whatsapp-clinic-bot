# Clinic Bot (Simple)

WhatsApp par **booking + payment**, aur staff ke liye **ek Google Sheet**. Bas.

## Flow

1. Missed call (ya patient ka "Hi") -> WhatsApp chat shuru
2. Naam -> umar -> karan -> Aaj/Udya -> time slot
3. UPI QR aata hai -> patient payment ka screenshot bhejta hai
4. Staff ke WhatsApp par screenshot + **Confirm / Hold** button aate hain
5. Staff Confirm dabata hai -> booking Sheet me save + patient ko token milta hai
6. Staff ko har booking ke saath **Sheet ka link** milta hai. Staff "SHEET" likh ke bhi link mangwa sakta hai.

Fee = 0 ho to payment skip hota hai (staff ko sirf Confirm dabana hota hai).

## Staff ke liye Sheet

| Tab | Kya dikhta hai |
|---|---|
| **Today** | Sirf aaj ki bookings (apne aap, formula se). Cancelled wali nahi dikhti. |
| **Bookings** | Saari bookings: naam, umar, karan, date, time, token, payment status, fee |
| **Pending** | Jo patient abhi chat me hain / payment verify hona baaki hai |
| **Capacity** | Slots (apne aap banti hain) |
| **Settings** | Fee, UPI ID, staff number, timing |

**Booking cancel karni ho:** Bookings tab me us row ka `Booking Status` badal ke `Cancelled` likho. Slot wapas khali ho jayega.

**Staff ko Sheet dikhane ke liye:** Google Sheet ko staff ke Gmail se Share karo (ya "Anyone with link: Viewer"). Phone par Google Sheets app me khulega.

**Today tab ka time:** Sheet me File > Settings > Time zone = India (Kolkata) rakho, warna "aaj" galat din ka ho sakta hai.

## Settings tab (zaruri)

- `Appointment Fee` (pehle "New Patient Fee" tha - purani Sheet me wahi chalega)
- `UPI ID`
- `Staff WhatsApp Number` (91 ke saath, bina +)
- `Clinic Name`
- Timing: `Morning Start/End`, `Evening Start/End`, `Slot Duration Minutes`, `Max Capacity Per Slot`
- Optional: `Alert WhatsApp Number` (server error ka alert yaha aata hai, nahi diya to staff number par)

Sheet ki tabs/columns server start par apne aap ban jaati hain (`schema.js`). Kuch bhi delete ya badla nahi jata.

## Environment variables (Render)

```
GOOGLE_SHEET_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_PRIVATE_KEY
WHATSAPP_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_VERIFY_TOKEN
TRIGGER_SECRET
DOCTOR_WHATSAPP_NUMBER     (optional - Settings me Staff number ho to zaruri nahi)
CLINIC_NAME                (optional)
APP_BASE_URL               (optional - Render par apne aap set hota hai)
```

Ab zaruri nahi: `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_BACKUP_FOLDER_ID`, `PROFILE_LINK_VALID_DAYS`, Drive API.

## Files

```
server.js     WhatsApp flow, staff Confirm, admin links
sheets.js     Google Sheet padhna/likhna, slots, token
schema.js     Sheet ka structure apne aap banata hai (+ Today tab)
messages.js   Patient ko jaane wale messages (Marathi / Hindi / English)
whatsapp.js   WhatsApp Cloud API
alerts.js     Server error aaye to staff ko WhatsApp alert
```

## Admin links (browser me)

- `/admin/generate-slots?secret=TRIGGER_SECRET` - slots abhi banao (waise roz apne aap banti hain)
- `/admin/ensure-schema?secret=TRIGGER_SECRET` - Sheet setup abhi chalao
- `/admin/debug-bookings?secret=TRIGGER_SECRET` - server Bookings tab me kya dekh raha hai

## Hata diya gaya (purane version se)

Case paper, medicine database, dashboard, patients list, live queue, reports, expenses/invoice, staff PIN login, multi-doctor, patient profile link, file upload, patient cancel/reschedule page, appointment reminders, daily Drive backup, audit log.
