# Event Ticketing System

A simple event ticketing website where attendees **register**, receive an **email with a unique QR code**, and get **marked as attended** in a **Google Sheet** when their QR is scanned.

## What it does

1. **Visitor** opens the site and sees a list of **events** (like [TicketsMarche](https://www.ticketsmarche.com/)).
2. They **select an event** and click "Register & Get Ticket".
3. On the registration page they enter **name** and **email**; the system creates a unique ticket ID, saves the attendee (with the event name) to a Google Sheet, generates a unique QR code, and sends an email with the QR and a link to the ticket page.
4. **At the event**, staff (or the attendee) scans the QR code. The QR opens a check-in URL that marks that ticket as **Attended** in the sheet and shows “Checked in!”.
5. **Google Sheet** columns: **Name**, **Email**, **Ticket ID**, **Event**, **Attended** (YES/NO), **Check-in Time**.

Supports 200+ attendees; each person gets a unique, unguessable ticket ID and QR. Events are defined in `public/events.json`—edit that file to add or change events.

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env` and fill in (values shown are examples):

```env
BASE_URL=http://localhost:3001
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
GOOGLE_SHEET_ID=your_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_JSON=path/to/service-account.json
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_APP_PASSWORD=your-app-password
EVENT_NAME=My Awesome Event
# EMAIL_VIA_SUPABASE=true   # optional: let Supabase Edge Function send ticket email instead of Node
ADMIN_API_KEY=change-me-admin-secret
```

- **BASE_URL** – URL where the site runs (e.g. `https://yoursite.com`). Used in QR links and emails.
- **GOOGLE_SHEET_ID** – From the sheet URL: `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`
- **GOOGLE_SERVICE_ACCOUNT_JSON** – Path to the JSON key file (see Google setup below).
- **EMAIL_USER** and **EMAIL_APP_PASSWORD** – Required if you want users to **receive an email with their QR ticket** when they register. For Gmail: turn on 2-Step Verification, then create an [App Password](https://support.google.com/accounts/answer/185833) (not your normal password). Put that 16-character password in `EMAIL_APP_PASSWORD`. If these are not set, registration still works but no email is sent; the user can still view their ticket on the website.
- **EMAIL_VIA_SUPABASE** – If set to `true`, the Node server will **not** send the email itself. Instead, you can use a Supabase Edge Function + trigger (see `supabase-schema.sql` and `supabase-functions/send-ticket-email`) so Supabase sends the email when a new attendee row is inserted.
- **ADMIN_API_KEY** – Shared secret used by the admin dashboard (`/admin`) to call `/api/admin/events`. Keep this private.

### 3. Google Sheet setup

1. Create a new Google Sheet.
2. Add a sheet (tab) named **exactly** `Attendees`.
3. In row 1 put headers: **Name** | **Email** | **Ticket ID** | **Event** | **Attended** | **Check-in Time**  
   (The app can create this row automatically on first run if the sheet is empty.)
4. **Google Cloud / Service account:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/) → create or select a project.
   - Enable **Google Sheets API**.
   - Create a **Service Account** (IAM → Service Accounts → Create). Download its **JSON key**.
   - Save the JSON file somewhere safe and set `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env` to its path (e.g. `./google-key.json`).
5. **Share the sheet** with the service account email (from the JSON, e.g. `xxx@project.iam.gserviceaccount.com`) as **Editor**.

### 4. Run the server

```bash
npm start
```

Open `http://localhost:3000`, register with a name and email, and check your inbox for the ticket email with the QR code.

---

## How check-in works

- Each QR code encodes: `{BASE_URL}/checkin/{ticketId}`.
- When someone **scans the QR** (or opens that link on their phone), the page loads and the server:
  - Finds the row in the sheet with that **Ticket ID**
  - Sets **Attended** to **YES** and **Check-in Time** to the current time
  - Shows a “Checked in!” page (or “Invalid ticket” if the ID is wrong).

So: **scan QR → open link → sheet is updated automatically.**

---

## Optional: scanner app

You can use any QR scanner that opens URLs (e.g. phone camera, or a “QR scanner” app). When it opens `https://yoursite.com/checkin/abc-123-...`, that person is marked attended.

For a programmatic scanner (e.g. tablet at the door), you can call:

- **GET** `https://yoursite.com/api/checkin/{ticketId}`  
  Returns JSON: `{ "ok": true }` or `{ "ok": false }` if the ticket was not found.

---

## File overview

| File / folder       | Purpose |
|---------------------|--------|
| `server.js`         | Express server: events API, registration, Google Sheet, email, QR, check-in |
| `public/index.html` | Homepage: list of events (event cards with "Register & Get Ticket") |
| `public/register.html` | Registration form for the selected event |
| `public/admin.html`    | Admin dashboard UI (create / edit / reorder events) |
| `public/events.json`   | Local fallback list of events (id, name, date, time, venue, image, description). When Supabase `events` table is configured, `/api/events` reads from the database instead. |
| `supabase-schema.sql`  | SQL to create `attendees` and `events` tables and an optional trigger stub for Supabase-driven ticket emails |
| `supabase-functions/send-ticket-email/index.ts` | Example Supabase Edge Function that sends the QR ticket email via Resend |
| `.env`              | Your config (do not commit; copy from `.env.example`) |
| `README.md`         | This file |

---

## Notes

- Each attendee gets a **unique ticket ID** (UUID). The QR is unique and tied to that ID.
- If you don’t set Google or email in `.env`, the app still runs: registration will work but won’t save to a sheet or send email (useful for local testing).
- For production, run behind HTTPS and set `BASE_URL` to your real domain so QR links work correctly.
