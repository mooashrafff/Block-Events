# QA Test Report – Event Ticketing System

**Date:** Pre-deployment checklist  
**Tester Role:** QA Engineer  
**Target:** Vercel deployment readiness

---

## 1. QR Code Flow – Test Checklist

### 1.1 QR Code Generation
| # | Test Case | Expected | Status |
|---|-----------|----------|--------|
| 1.1.1 | Register for event → QR appears on page | QR code displays, links to `{BASE_URL}/checkin/{ticketId}` | ⬜ |
| 1.1.2 | QR code is scannable (use phone camera) | Opens check-in URL in browser | ⬜ |
| 1.1.3 | QR encodes correct URL format | `https://your-domain.com/checkin/XXXXX` (5-char ticket ID) | ⬜ |
| 1.1.4 | Ticket ID is 5 chars (e.g. `7K2N9`) | Unique, alphanumeric, no I/O confusion | ⬜ |

### 1.2 QR Code Display Locations
- **Register success card** – Inline after form submit ✓
- **Ticket page** (`/ticket/:ticketId`) – Full page with QR ✓
- **Email** – Embedded image + attachment (if email configured) ✓
- **My tickets** – "View ticket / QR" opens `/ticket/:id` ✓

---

## 2. Scanner Flow – Test Checklist

### 2.1 Camera Scan
| # | Test Case | Expected | Status |
|---|-----------|----------|--------|
| 2.1.1 | Open `/scan` → Start camera | Camera view shows, QR scan region visible | ⬜ |
| 2.1.2 | Scan valid ticket QR | "Checked in!" (green) | ⬜ |
| 2.1.3 | Scan same ticket again | "Already checked in" (yellow) | ⬜ |
| 2.1.4 | Scan invalid/fake QR | "Invalid ticket" (red) | ⬜ |
| 2.1.5 | Scanner auto-resumes after result | After ~2.2s, ready for next scan | ⬜ |

### 2.2 Manual Entry (Fallback)
| # | Test Case | Expected | Status |
|---|-----------|----------|--------|
| 2.2.1 | Enter valid 5-char ticket ID → Check in | "Checked in!" | ⬜ |
| 2.2.2 | Enter invalid ticket ID | "Invalid ticket" | ⬜ |
| 2.2.3 | Press Enter in input | Same as clicking Check in | ⬜ |
| 2.2.4 | Empty input → Check in | "Enter a ticket ID" error | ⬜ |

### 2.3 API Used by Scanner
- **Endpoint:** `GET /api/checkin/:ticketId`
- **Returns:** `{ ok: true, alreadyScanned?: true }` or `{ ok: false }`
- **Scanner** calls `fetch('/api/checkin/' + ticketId)` – uses relative URL ✓

---

## 3. Ticket & Check-in Logic

### 3.1 Data Flow
```
Registration → Supabase (attendees) + optional Google Sheet
     ↓
QR encodes: {BASE_URL}/checkin/{ticketId}
     ↓
Scanner scans OR user visits /checkin/:ticketId
     ↓
markAttended(ticketId) → Supabase + Sheet update
```

### 3.2 Critical Dependencies
| Dependency | Purpose | Required |
|------------|---------|----------|
| **Supabase** | Attendees table, ticket lookup, mark attended | Yes (for production) |
| **Google Sheet** | Optional backup/log | No |
| **Email (nodemailer)** | Send ticket email | Optional |

### 3.3 Ticket Page Behavior
| # | Test Case | Expected | Status |
|---|-----------|----------|--------|
| 3.3.1 | Unscanned ticket | QR visible, no red border | ⬜ |
| 3.3.2 | After scan | Red border, Arabic "تم مسح الرمز من قبل" | ⬜ |
| 3.3.3 | "View all my tickets" link | Goes to /my-tickets?email=xxx, no re-login | ⬜ |
| 3.3.4 | No "Open check-in link" | Link removed (no self-check-in) ✓ | ✅ |

---

## 4. Vercel Deployment – Critical Notes

### 4.1 Current Stack
- **Runtime:** Node.js, Express
- **Entry:** `server.js` (uses `app.listen()`)
- **Static:** `public/` folder

### 4.2 Vercel Limitations
Vercel is **serverless**. A plain Express app with `app.listen()` typically needs adaptation:

1. **Option A:** Use [Vercel Express adapter](https://vercel.com/docs/frameworks/backend/express) – export Express app as serverless handler.
2. **Option B:** Use **Vercel Serverless Functions** – move API routes to `/api/*.js`.
3. **Option C:** Deploy to **Railway, Render, or Fly.io** – they support long-running Node servers natively.

### 4.3 BASE_URL for Production
| Env Var | Local | Vercel |
|---------|-------|--------|
| `BASE_URL` | `http://localhost:3001` | `https://your-app.vercel.app` |
| QR codes | Must use production URL when deployed | Set in Vercel env vars |

**Important:** If `BASE_URL` is wrong, QR codes will point to localhost and fail on production.

### 4.4 Environment Variables to Set in Vercel
- `BASE_URL` = Your Vercel deployment URL
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_API_KEY`
- `EMAIL_USER`, `EMAIL_APP_PASSWORD` (if using email)
- `GOOGLE_SERVICE_ACCOUNT_JSON` – **file path won’t work on Vercel**. Use JSON string in env instead.

### 4.5 Google Sheets on Vercel
`GOOGLE_SERVICE_ACCOUNT_JSON` is a **file path** (e.g. `./key.json`). On Vercel:
- Store the JSON content in an env var (e.g. `GOOGLE_CREDENTIALS`)
- Parse it in code: `JSON.parse(process.env.GOOGLE_CREDENTIALS)`
- Pass the parsed object to `GoogleAuth` instead of `keyFilename`

---

## 5. Scanner-Specific Checks

### 5.1 HTTPS
- Camera API (`getUserMedia`) **requires HTTPS** in production (except localhost).
- Vercel provides HTTPS ✓

### 5.2 CORS
- Scanner uses same-origin `fetch('/api/checkin/...')` – no CORS issue if on same domain ✓

### 5.3 Mobile Scanner
- Test on real phone: open `/scan`, allow camera, scan a ticket from another device ✓
- html5-qrcode works on mobile browsers ✓

---

## 6. Suggested Manual Test Script

```
1. Start server: npm start
2. Set BASE_URL in .env (or leave localhost for local test)
3. Register: Go to /register (or /register?eventId=xxx), submit form
4. Verify: Ticket card shows QR, 5-char ticket ID, event name, expiry
5. Open ticket: Click "Open ticket page" → /ticket/XXXXX
6. Scan: On phone, open /scan, start camera, scan the QR from step 4
7. Verify: "Checked in!" on scanner
8. Rescan: Scan same QR again → "Already checked in"
9. Ticket page: Refresh /ticket/XXXXX → Red border, Arabic text
10. Manual: Enter ticket ID in scanner, click Check in → "Checked in!"
11. Invalid: Enter "XXXXX" (fake id) → "Invalid ticket"
```

---

## 7. Known Issues / Gaps

| # | Issue | Severity | Notes |
|---|-------|----------|-------|
| 1 | No `vercel.json` | High | Need serverless config for Express |
| 2 | `GOOGLE_SERVICE_ACCOUNT_JSON` file path | Medium | Won’t work on Vercel; use env JSON |
| 3 | `initSheets()` blocks startup | Low | App still runs if Sheets fail |
| 4 | No Supabase = no attendees | High | Must have Supabase for prod |

---

## 8. Summary

| Area | Status | Action |
|------|--------|--------|
| QR generation | OK | Test encode/decode |
| QR display | OK | Verify on all surfaces |
| Scanner (camera) | OK | Test on real device + HTTPS |
| Scanner (manual) | OK | Test 5-char ID entry |
| Check-in API | OK | Returns correct JSON |
| Ticket page (scanned state) | OK | Red border + Arabic |
| Vercel readiness | ⚠️ | Add vercel config, fix BASE_URL and Google creds |

---

---

## 9. Pre-Deploy Checklist – Run These

### Local test (before pushing)
```powershell
cd "c:\Users\moham\OneDrive\Desktop\New folder"
npm start
```
Then:
1. Open `http://localhost:3001` in browser
2. Register → get ticket with QR
3. Open `http://localhost:3001/scan` (allow camera)
4. Scan the QR → expect "Checked in!"
5. Scan again → expect "Already checked in"
6. Refresh ticket page → expect red border + Arabic text

### Vercel deploy
- Vercel auto-detects Express (`server.js` in root) – zero config
- Static files in `public/` are served from CDN
- Set env vars in Vercel dashboard: `BASE_URL`, `SUPABASE_*`, etc.
- **Set `BASE_URL` = `https://your-app.vercel.app`** after first deploy

---

**Next steps before deploy:**
1. Run the manual test script locally
2. Deploy to Vercel (CLI: `vercel` or connect Git)
3. Set `BASE_URL` and all env vars in Vercel dashboard
4. Test scanner on production URL (HTTPS)

---

## 10. Pre-launch audit (2026-04-13) — code + Supabase

### Schema / SQL (run or verify in Supabase)
| Item | Status |
|------|--------|
| `pgcrypto` extension | Required once; duplicate `CREATE EXTENSION` lines removed from `supabase-schema.sql` |
| `app_users`: `phone`, `birthdate`, `gender`, password reset columns | Covered by `ALTER TABLE ... IF NOT EXISTS` in schema — safe to re-run |
| `bookings.status` | Column is `text` (no enum). Server uses `paid`, `pending_payment`, `confirmed`, etc. — **no SQL enum change needed** |
| `bookings` index | Added `bookings_user_status_idx (user_id, status)` — also shipped in **`supabase-production-deltas.sql`** for paste-into-SQL-Editor upgrades |
| `events.extra` (jsonb) | Already in schema; server reads/writes it |
| `country-dial-codes.json` | Static file under `public/` — ensure deploy includes it (signup international phone) |

### Environment (production)
| Variable | Notes |
|----------|--------|
| `JWT_SECRET` | **Must** be set in production (server warns if empty) |
| `BASE_URL` | Must match public HTTPS URL (QR links, OAuth redirect) |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must exactly match URI configured in Google Cloud Console |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; never expose to browser |

### Code sanity

| Check | Result |
|-------|--------|
| `node --check server.js` | Passes |
| `/api/auth/profile` | Uses `requireAuth` → returns 503 if Supabase unset |
| Google new users | Random `password_hash` stored (password login unusable until reset — documented in code) |
| Signup `phone` | E.164 validated server-side (8–15 digits after `+`) |

### Manual smoke tests before go-live
1. **Auth:** email signup (with/without phone), login, forgot/reset password, Google OAuth (production redirect).
2. **Events:** list, detail, add to cart, checkout (free + paid/InstaPay if used).
3. **My tickets / ticket page:** QR loads; resend email if mail configured.
4. **Admin:** login with `ADMIN_API_KEY`; create/edit event; list attendees.
5. **Scanner:** `/scan` on **HTTPS**; approve pending device if using approval flow; scan valid → success; repeat → already used.
6. **Blocked users:** block email/phone in admin; confirm registration rejected.

### Known gaps / follow-ups (not blockers if you accept risk)
- Legacy `PATCH /api/profile` updates **`attendees`** by email (not `app_users`). The in-app profile UI uses **`/api/auth/profile`** (updates `app_users`). If you still call the old endpoint, behaviour may diverge.
- No automated `npm test` in repo — rely on manual checklist above.
- RLS: tables are accessed with **service role** from Node; RLS policies on these tables are optional for this architecture.
