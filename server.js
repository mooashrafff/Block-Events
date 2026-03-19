require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 5-char alphanumeric ticket ID (0-9, A-Z) – unique, easy for scanners to type
const SHORT_ID_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // omit I,O to avoid confusion
function generateShortTicketId() {
  let id = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) id += SHORT_ID_CHARS[bytes[i] % SHORT_ID_CHARS.length];
  return id;
}
async function getUniqueShortTicketId() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = generateShortTicketId();
    const existing = supabase ? await getAttendeeByTicketId(id) : null;
    if (!existing) return id;
  }
  return uuidv4().replace(/-/g, '').slice(0, 5); // fallback
}
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const fs = require('fs');

const app = express();
// Use 3001 by default to avoid conflicts with other apps on 3000
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  console.warn('JWT_SECRET not set – auth will be insecure in production. Set JWT_SECRET in .env.');
}

// ----- Supabase (for saving attendees) -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn('Supabase env vars not set – running without Supabase (only sheet/email).');
}

async function saveAttendeeToSupabase({ name, email, phone, ticketId, eventId, eventName, ticketCategory, ticketNumber }) {
  if (!supabase) return;
  const { error } = await supabase.from('attendees').insert({
    name,
    email,
    phone: phone || null,
    ticket_id: ticketId,
    ticket_category: ticketCategory || null,
    ticket_number: ticketNumber || null,
    event_id: eventId || null,
    event_name: eventName || null,
  });
  if (error) {
    console.error('Supabase insert error:', error.message);
  }
}

async function isUserBlocked(email, phone) {
  if (!supabase) return false;
  const e = (email || '').trim().toLowerCase();
  const p = (phone || '').trim().replace(/\D/g, '');
  if (e) {
    const { data } = await supabase.from('blocked_users').select('id').eq('email', e).limit(1);
    if (data && data.length) return true;
  }
  if (p) {
    const { data } = await supabase.from('blocked_users').select('id').eq('phone', p).limit(1);
    if (data && data.length) return true;
  }
  return false;
}

async function blockUser(email, phone) {
  if (!supabase) return { error: 'Supabase not configured.' };
  const e = (email || '').trim().toLowerCase() || null;
  const p = (phone || '').trim().replace(/\D/g, '') || null;
  if (!e && !p) return { error: 'Email or phone required to block.' };
  const { error } = await supabase.from('blocked_users').insert({ email: e || null, phone: p || null });
  if (error) return { error: error.message };
  return {};
}

async function findExistingRegistration(email, phone, eventId, eventName) {
  if (!supabase) return null;
  const e = (email || '').trim().toLowerCase();
  const p = (phone || '').trim().replace(/\D/g, '');
  if (!e && !p) return null;
  let query = supabase.from('attendees').select('id, email, phone');
  if (eventId) {
    query = query.eq('event_id', eventId);
  } else {
    query = query.eq('event_name', eventName || 'Event');
  }
  const { data, error } = await query;
  if (error || !data) return null;
  const byEmail = e && data.some(r => (r.email || '').toLowerCase() === e);
  const byPhone = p && data.some(r => r.phone && (r.phone || '').replace(/\D/g, '') === p);
  if (byEmail) return { type: 'email' };
  if (byPhone) return { type: 'phone' };
  return null;
}

async function getAttendeeByTicketId(ticketId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('attendees')
    .select('id, attended, email, name, event_name, event_id, ticket_category, ticket_number')
    .eq('ticket_id', ticketId)
    .maybeSingle();
  if (error) {
    console.error('Supabase get attendee error:', error.message);
    return null;
  }
  return data;
}

async function markAttendedInSupabase(ticketId, scannerName, scannerPhone) {
  if (!supabase) return false;
  const payload = {
    attended: true,
    checkin_time: new Date().toISOString(),
    ...(scannerName != null && { scanned_by_name: String(scannerName).trim() || null }),
    ...(scannerPhone != null && { scanned_by_phone: String(scannerPhone).trim() || null }),
  };
  const { data, error } = await supabase
    .from('attendees')
    .update(payload)
    .eq('ticket_id', ticketId)
    .select('id');
  if (error) {
    console.error('Supabase update error:', error.message);
    return false;
  }
  return data && data.length > 0;
}

// Allow slightly larger JSON bodies (for base64 event images from admin)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

function signSessionToken(user) {
  const payload = { sub: user.id, email: user.email };
  return jwt.sign(payload, JWT_SECRET || 'dev-insecure-secret', { expiresIn: '30d' });
}

function setSessionCookie(res, token) {
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie('session', { path: '/' });
}

async function getAuthUserFromRequest(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET || 'dev-insecure-secret');
    const userId = decoded?.sub;
    if (!userId || !supabase) return null;
    const { data, error } = await supabase
      .from('app_users')
      .select('id, name, email, profile_picture_url, created_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

async function requireAuth(req, res) {
  if (!supabase) {
    res.status(503).json({ error: 'Supabase not configured.' });
    return null;
  }
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Not logged in.' });
    return null;
  }
  req.user = user;
  return user;
}

// Load about-us page at startup (avoids sendFile issues on Windows/OneDrive)
let aboutUsHtml = null;
try {
  aboutUsHtml = fs.readFileSync(path.join(__dirname, 'public', 'about-us.html'), 'utf8');
} catch (e) {
  console.error('Failed to load about-us.html:', e.message);
}

// Page routes (before static so /events, /contact, /my-tickets don't 404)
app.get('/events', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'events.html'));
});
app.get('/auth', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});
app.get('/cart', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cart.html'));
});
app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});
app.get('/payment', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});
app.get('/instapay-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'instapay-success.html'));
});
app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});
app.get('/about-us', (req, res) => {
  if (aboutUsHtml) {
    res.type('html').send(aboutUsHtml);
  } else {
    res.status(500).send('About Us page not available.');
  }
});
app.get('/who-we-are', (req, res) => res.redirect(301, '/about-us'));
app.get('/what-we-do', (req, res) => res.redirect(301, '/about-us'));
app.get('/my-tickets', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'my-tickets.html'));
});
app.get('/scan', (req, res) => {
  const filePath = path.resolve(__dirname, 'public', 'scan.html');
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Scan page error:', err);
      if (!res.headersSent) {
        res.status(err.status || 500).send(
          err.status === 404 ? 'Scanner page not found.' : 'Could not load scanner page.'
        );
      }
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// Events from local JSON (fallback if Supabase/events table not used)
function getEventsFromFile() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'events.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

const EVENTS_FILE_PATH = path.join(__dirname, 'public', 'events.json');

function setEventsToFile(events) {
  try {
    fs.writeFileSync(EVENTS_FILE_PATH, JSON.stringify(events || [], null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Could not write events.json:', e.message);
    return false;
  }
}

// Rules are stored separately from the huge events.json file so admin edits stay lightweight.
const EVENT_RULES_FILE_PATH = path.join(__dirname, 'public', 'event-rules.json');

function getEventRulesFromFile() {
  try {
    const raw = fs.readFileSync(EVENT_RULES_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function setEventRulesToFile(rulesMap) {
  try {
    fs.writeFileSync(EVENT_RULES_FILE_PATH, JSON.stringify(rulesMap || {}, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Could not write event-rules.json:', e.message);
    return false;
  }
}

function getDefaultEventRules() {
  return {
    startTime: '7:00 PM',
    doorsOpenTime: '4:00 PM',
    doorsCloseTime: '7:00 PM',
    minAge: 12,
    accompaniedByAdultUnderAge: 15,
    termsText:
      'By purchasing these tickets, you confirm your acceptance of all terms and conditions of Ticketsmarche.com and/or any affiliated sites using the Ticketsmarche.com domain and/or technology, including but not limited to, the no refunds and no exchange policy.',
  };
}

function normalizeEventRules(input) {
  const d = getDefaultEventRules();
  if (!input || typeof input !== 'object') return d;
  return {
    startTime: input.startTime || d.startTime,
    doorsOpenTime: input.doorsOpenTime || d.doorsOpenTime,
    doorsCloseTime: input.doorsCloseTime || d.doorsCloseTime,
    minAge: Number.isFinite(Number(input.minAge)) ? Number(input.minAge) : d.minAge,
    accompaniedByAdultUnderAge: Number.isFinite(Number(input.accompaniedByAdultUnderAge))
      ? Number(input.accompaniedByAdultUnderAge)
      : d.accompaniedByAdultUnderAge,
    termsText: input.termsText || d.termsText,
  };
}

function normalizeAdminEventFromFile(event, sortOrderIndex) {
  const price = event && event.price != null && event.price !== '' ? Number(event.price) : 0;
  const availableTickets = event && event.available_tickets != null ? Number(event.available_tickets) : null;
  return {
    id: event.id,
    slug: event.slug || null,
    name: event.name || '',
    date: event.date || null,
    time: event.time || null,
    venue: event.venue || null,
    category: event.category || null,
    image: event.image || null,
    description: event.description || null,
    price: Number.isFinite(price) ? price : 0,
    available_tickets: availableTickets != null && Number.isFinite(availableTickets) ? availableTickets : null,
    sort_order: sortOrderIndex != null ? sortOrderIndex : null,
  };
}

function loadAdminEventsFromFile() {
  const events = getEventsFromFile() || [];
  return events.map((e, idx) => normalizeAdminEventFromFile(e, idx + 1));
}

// Map Supabase events rows into the public event shape
function mapEventRowToPublic(row) {
  if (!row) return null;
  const id = row.slug || row.id;
  const price = row.price != null && row.price !== '' ? Number(row.price) : 0;
  return {
    id,
    name: row.name,
    date: row.date,
    time: row.time,
    venue: row.venue,
    category: row.category,
    image: row.image || '/block-logo.png',
    description: row.description,
    price,
    type: price > 0 ? 'paid' : 'free',
  };
}

// Prefer Supabase events table; fall back to JSON file
async function listEventsForPublic() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('events')
        .select('id, slug, name, date, time, venue, category, image, description, price, sort_order, created_at')
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });
      if (!error && data && data.length) {
        return data.map(mapEventRowToPublic);
      }
      if (error) {
        console.error('Supabase events error:', error.message);
      }
    } catch (e) {
      console.error('Supabase events exception:', e.message);
    }
  }
  return getEventsFromFile();
}

async function getEventById(id) {
  if (!id) return null;
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('events')
        .select('id, slug, name, date, time, venue, category, image, description, price')
        .or(`id.eq.${id},slug.eq.${id}`)
        .limit(1)
        .maybeSingle();
      if (!error && data) {
        return mapEventRowToPublic(data);
      }
      if (error && error.code !== 'PGRST116') {
        console.error('Supabase getEventById error:', error.message);
      }

      // Fallback: case-insensitive slug match (TicketsMarche-like URLs)
      const slugVariants = [
        id,
        id.replace(/_/g, '-'),
        id.replace(/-/g, '_'),
      ];
      for (const v of slugVariants) {
        const { data: data2, error: error2 } = await supabase
          .from('events')
          .select('id, slug, name, date, time, venue, category, image, description, price')
          .ilike('slug', v)
          .limit(1)
          .maybeSingle();
        if (!error2 && data2) return mapEventRowToPublic(data2);
      }
    } catch (e) {
      console.error('Supabase getEventById exception:', e.message);
    }
  }
  return getEventsFromFile().find((e) => e.id === id) || null;
}

// Resolve event to its canonical UUID row (used for cart/bookings FK columns)
async function resolveEventRowByIdOrSlug(idOrSlug) {
  const id = String(idOrSlug || '').trim();
  if (!id || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('events')
      .select('id, slug, name, date, time, venue, category, image, description, price')
      .or(`id.eq.${id},slug.eq.${id}`)
      .limit(1)
      .maybeSingle();
    if (!error && data) return data || null;
    if (error && error.code && error.code !== 'PGRST116') {
      // fall through to ilike fallback
    }

    // Fallback: case-insensitive slug match.
    const slugVariants = [
      id,
      id.replace(/_/g, '-'),
      id.replace(/-/g, '_'),
    ];
    for (const v of slugVariants) {
      const { data: data2, error: error2 } = await supabase
        .from('events')
        .select('id, slug, name, date, time, venue, category, image, description, price')
        .ilike('slug', v)
        .limit(1)
        .maybeSingle();
      if (!error2 && data2) return data2 || null;
    }

    return null;
  } catch {
    return null;
  }
}

// ----- Admin helpers for events dashboard -----

function isAdminRequest(req) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const headerKey = (req.headers['x-admin-key'] || req.headers['X-Admin-Key'] || '').toString();
  return headerKey && headerKey === adminKey;
}

function isLocalhostRequest(req) {
  const candidate = String(
    (req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'])) ||
      req.ip ||
      req.connection?.remoteAddress ||
      ''
  );
  // x-forwarded-for might be a list: take the last hop
  const ip = candidate.split(',').map((s) => s.trim()).filter(Boolean).slice(-1)[0] || '';
  return ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
}

function requireScanner(req, res) {
  // Allow localhost for dev convenience.
  if (isLocalhostRequest(req)) return true;

  const expected = process.env.SCANNER_API_KEY || process.env.ADMIN_API_KEY || '';
  if (!expected) {
    res.status(503).json({ error: 'SCANNER_API_KEY not set on server.' });
    return false;
  }
  const headerKey = String(req.headers['x-scanner-key'] || req.headers['x-admin-key'] || '').trim();
  if (!headerKey || headerKey !== expected) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  return true;
}

async function requireAdmin(req, res) {
  // Local dev convenience: allow admin APIs from localhost unconditionally.
  // Non-local access is still protected by ADMIN_API_KEY.
  if (isLocalhostRequest(req)) return null;

  if (!process.env.ADMIN_API_KEY) {
    return res.status(503).json({ error: 'ADMIN_API_KEY not set on server.' });
  }
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  return null;
}

// Aggregate registrations per event for admin dashboard
async function getEventStatsForAdmin() {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('attendees')
      .select('event_id, event_name, attended');
    if (error) {
      console.error('Supabase event stats error:', error.message);
      return [];
    }
    const map = new Map();
    for (const row of data || []) {
      const key = row.event_id || row.event_name || 'unknown';
      const name = row.event_name || 'Event';
      if (!map.has(key)) {
        map.set(key, { eventId: row.event_id || null, eventName: name, total: 0, attended: 0 });
      }
      const item = map.get(key);
      item.total += 1;
      if (row.attended === true) item.attended += 1;
    }
    return Array.from(map.values()).map((item) => ({
      eventId: item.eventId,
      eventName: item.eventName,
      total: item.total,
      attended: item.attended,
      notAttended: item.total - item.attended,
      attendanceRate: item.total ? item.attended / item.total : 0,
    }));
  } catch (e) {
    console.error('Admin event stats exception:', e.message);
    return [];
  }
}

// Google Sheet auth and helpers
let sheets = null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Attendees';

async function initSheets() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.warn('GOOGLE_SERVICE_ACCOUNT_JSON not set – running without sheet (demo mode).');
    return null;
  }
  const key = require(path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  sheets = google.sheets({ version: 'v4', auth: client });
  return sheets;
}

async function appendAttendee(name, email, phone, ticketId, eventName) {
  if (!sheets || !SHEET_ID) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[name, email, phone || '', ticketId, eventName || '', 'NO', '']],
    },
  });
}

async function findRowByTicketId(ticketId) {
  if (!sheets || !SHEET_ID) return null;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:G`,
  });
  const rows = res.data.values || [];
  const header = rows[0] || [];
  const dataRows = rows.slice(1);
  const colTicket = header.indexOf('Ticket ID') >= 0 ? header.indexOf('Ticket ID') : 3;
  const idx = dataRows.findIndex((r) => String(r[colTicket]).trim() === String(ticketId).trim());
  return idx >= 0 ? idx + 2 : null; // 1-based row number (2 = first data row)
}

async function markAttended(ticketId, scannerName, scannerPhone) {
  let updated = false;

  if (sheets && SHEET_ID) {
    const row = await findRowByTicketId(ticketId);
    if (row) {
      const now = new Date().toISOString();
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!F${row}:G${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['YES', now]] },
      });
      updated = true;
    }
  }

  const supabaseUpdated = await markAttendedInSupabase(ticketId, scannerName, scannerPhone);
  if (supabaseUpdated) updated = true;

  return { ok: updated };
}

// Email transporter
function getTransporter() {
  if (!process.env.EMAIL_USER) return null;
  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD,
    },
  });
}

// Logo as base64 for email (works even when BASE_URL is localhost)
let LOGO_DATA_URL = null;
function getLogoDataUrl() {
  if (LOGO_DATA_URL) return LOGO_DATA_URL;
  try {
    const logoPath = path.join(__dirname, 'public', 'block-logo.png');
    const buffer = fs.readFileSync(logoPath);
    const base64 = buffer.toString('base64');
    const ext = logoPath.endsWith('.png') ? 'png' : 'jpeg';
    LOGO_DATA_URL = `data:image/${ext};base64,${base64}`;
  } catch (e) {
    console.warn('Could not load logo for email:', e.message);
  }
  return LOGO_DATA_URL;
}

// Generate QR as Data URL (for inline in email) and buffer (for attachment)
async function generateQR(ticketId) {
  const checkInUrl = `${BASE_URL}/checkin/${ticketId}`;
  const dataUrl = await QRCode.toDataURL(checkInUrl, { width: 280, margin: 2 });
  const buffer = await QRCode.toBuffer(checkInUrl, { width: 400, margin: 2 });
  return { dataUrl, buffer, checkInUrl };
}

function buildTicketEmailHtml({ name, eventName, ticketId, dataUrl, checkInUrl }) {
  const safe = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const safeName = safe(name || 'there');
  const safeEvent = safe(eventName || 'your event');
  const safeTicketId = safe(ticketId);
  const rawTicketUrl = `${BASE_URL}/ticket/${ticketId}`;
  const safeTicketUrl = safe(rawTicketUrl);
  const logoUrl = `${BASE_URL}/block-logo.png`;
  const safeLogoUrl = safe(logoUrl);

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f5f5f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(15,23,42,0.18);">
            <tr>
              <td style="padding:20px 24px 12px;border-bottom:1px solid #e5e7eb;background:#f9fafb;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="left">
                      <img src="${safeLogoUrl}" alt="BLOCK" width="110" style="display:block;height:auto;max-width:110px;" />
                    </td>
                  </tr>
                  <tr>
                    <td style="padding-top:18px;">
                      <h1 style="margin:0;font-size:20px;line-height:1.3;color:#111827;">Your ticket for ${safeEvent}</h1>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 8px;">
                <p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#4b5563;">Hi ${safeName},</p>
                <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b5563;">
                  Here is your ticket. Show this QR code at the entrance to check in.
                </p>
                <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#6b7280;">
                  Find the attached ticket below:
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px;">
                  <tr>
                    <td align="center" style="padding:16px 18px;background:#f3f4f6;border-radius:14px;">
                      <img src="cid:ticket-qr" alt="Ticket QR code" width="220" height="220" style="display:block;width:220px;height:220px;" />
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#6b7280;">
                  Or open your ticket online:
                  <a href="${safeTicketUrl}" style="display:inline-block;margin-top:8px;padding:10px 18px;border-radius:999px;background:#4f46e5;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;">
                    View my ticket
                  </a>
                </p>
                <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
                  Ticket ID:
                  <strong style="color:#111827;">${safeTicketId}</strong>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px 20px;background:#f9fafb;border-top:1px solid #e5e7eb;">
                <p style="margin:0;font-size:14px;line-height:1.5;color:#111827;font-weight:600;">See you there,</p>
                <p style="margin:4px 0 0;font-size:12px;line-height:1.5;color:#9ca3af;">BLOCK Events</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function generateInstapayQrDataUrl(paymentRef) {
  // Payment QR for user to scan/approve (mocked). QR encodes a simple reference string.
  return QRCode.toDataURL(String(paymentRef || ''), { width: 280, margin: 2 });
}

function getPaymentRefForBooking(bookingId) {
  return `INSTAPAY:${String(bookingId)}`;
}

async function sendTicketEmailToUser({ toEmail, name, eventName, ticketId }) {
  const transporter = getTransporter();
  if (!transporter) {
    // Email is optional for local/dev usage.
    return { ok: false, skipped: true };
  }

  const { dataUrl, buffer, checkInUrl } = await generateQR(ticketId);
  const html = buildTicketEmailHtml({
    name: name || '',
    eventName: eventName || '',
    ticketId,
    dataUrl,
    checkInUrl,
  });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: String(toEmail || '').trim(),
    subject: `Your ticket for ${eventName || 'event'}`,
    html,
    attachments: [{ filename: 'ticket-qr.png', content: buffer, cid: 'ticket-qr' }],
  });

  return { ok: true, skipped: false };
}

function buildTicketsEmailHtml({ name, eventName, tickets }) {
  const safe = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const safeName = safe(name || '');
  const safeEvent = safe(eventName || 'your event');
  const logoUrl = `${BASE_URL}/block-logo.png`;
  const safeLogoUrl = safe(logoUrl);

  const ticketBlocks = (Array.isArray(tickets) ? tickets : [])
    .map((t, idx) => {
      const ticketId = safe(t.ticketId);
      const ticketNumber = safe(t.ticketNumber ?? idx + 1);
      const ticketUrl = safe(`${BASE_URL}/ticket/${t.ticketId}`);
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 14px;">
          <tr>
            <td align="center" style="padding:14px 16px;background:#f3f4f6;border-radius:14px;">
              <img src="cid:ticket-qr-${idx}" alt="Ticket QR code" width="220" height="220" style="display:block;width:220px;height:220px;" />
              <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
                Ticket #<strong style="color:#111827;">${ticketNumber}</strong><br/>
                Ticket ID:<strong style="color:#111827;">${ticketId}</strong>
              </p>
              <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
                <a href="${ticketUrl}" style="display:inline-block;margin-top:6px;padding:10px 16px;border-radius:999px;background:#4f46e5;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;">
                  View my ticket
                </a>
              </p>
            </td>
          </tr>
        </table>
      `;
    })
    .join('');

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f5f5f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(15,23,42,0.18);">
            <tr>
              <td style="padding:20px 24px 12px;border-bottom:1px solid #e5e7eb;background:#f9fafb;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding-top:0;">
                      <img src="${safeLogoUrl}" alt="BLOCK" width="110" style="display:block;height:auto;max-width:110px;" />
                    </td>
                  </tr>
                  <tr>
                    <td style="padding-top:18px;">
                      <h1 style="margin:0;font-size:20px;line-height:1.3;color:#111827;">Your tickets for ${safeEvent}</h1>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 8px;">
                <p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#4b5563;">Hi ${safeName},</p>
                <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b5563;">
                  Here are your tickets. Show these QR codes at the entrance to check in.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 20px;">
                ${ticketBlocks || '<p style="margin:0;color:#6b7280;">No tickets attached.</p>'}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px 20px;background:#f9fafb;border-top:1px solid #e5e7eb;">
                <p style="margin:0;font-size:14px;line-height:1.5;color:#111827;font-weight:600;">See you there,</p>
                <p style="margin:4px 0 0;font-size:12px;line-height:1.5;color:#9ca3af;">BLOCK Events</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendTicketsEmailToUserMulti({ toEmail, name, eventName, tickets }) {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, skipped: true };

  const safeTickets = Array.isArray(tickets) ? tickets : [];
  if (!safeTickets.length) return { ok: false, skipped: true };

  const generated = [];
  for (let idx = 0; idx < safeTickets.length; idx++) {
    const t = safeTickets[idx] || {};
    const ticketId = String(t.ticketId || '').trim();
    if (!ticketId) continue;

    const { dataUrl, buffer } = await generateQR(ticketId);
    generated.push({
      ticketId,
      ticketNumber: t.ticketNumber,
      ticketCategory: t.ticketCategory,
      dataUrl,
      buffer,
    });
  }

  const html = buildTicketsEmailHtml({
    name: name || '',
    eventName: eventName || '',
    tickets: generated.map((t, i) => ({
      ticketId: t.ticketId,
      ticketNumber: t.ticketNumber ?? i + 1,
    })),
  });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: String(toEmail || '').trim(),
    subject: `Your tickets for ${eventName || 'event'}`,
    html,
    attachments: generated.map((t, idx) => ({
      filename: `ticket-qr-${idx + 1}.png`,
      content: t.buffer,
      cid: `ticket-qr-${idx}`,
    })),
  });

  return { ok: true, skipped: false };
}

async function insertAttendeeForBooking({ name, email, eventId, eventName, ticketId, ticketCategory, ticketNumber }) {
  // Also append to Google Sheet (if configured) for check-in + operational tracking.
  try {
    await appendAttendee(name, email, '', ticketId, eventName);
  } catch (e) {
    // Ignore sheet failures in local/demo mode.
  }

  await saveAttendeeToSupabase({
    name,
    email,
    phone: null,
    ticketId,
    eventId,
    eventName,
    ticketCategory,
    ticketNumber,
  });
}

// ----- Routes -----

app.get('/api/events', async (req, res) => {
  const events = await listEventsForPublic();
  res.json(events || []);
});

// Booking event details for the TicketsMarche-style flow
// Returns: facilities, location, ticket categories, and rules (per event).
app.get('/api/booking-event/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const base = await getEventById(id);
  if (!base) return res.status(404).json({ error: 'Event not found.' });

  const rulesMap = getEventRulesFromFile();
  const rulesKey = base.id || id;
  const rules = normalizeEventRules(rulesMap[rulesKey] || rulesMap[id] || null);

  // Ticket categories:
  // Your option 1A says categories come from events.json, but your current events.json is an event list.
  // To keep the booking flow functional, we generate default categories from the event price.
  const price = Number(base.price || 0);
  const tickets =
    Array.isArray(base.tickets) && base.tickets.length
      ? base.tickets
      : price > 0
      ? [
          { ticketId: 'regular', ticketName: 'Regular', ticketCategory: 'Regular', price },
          { ticketId: 'vip', ticketName: 'VIP', ticketCategory: 'VIP', price },
          { ticketId: 'early', ticketName: 'Early Bird', ticketCategory: 'Early Bird', price },
        ]
      : [{ ticketId: 'regular', ticketName: 'General Admission', ticketCategory: 'Regular', price: 0 }];

  const facilities = Array.isArray(base.facilities) ? base.facilities : base.venue ? [base.venue] : [];
  const location = base.location && typeof base.location === 'object' ? base.location : { address: base.venue || '', mapEmbedUrl: null };

  res.json({
    ...base,
    facilities,
    location,
    tickets: tickets.map((t) => ({
      id: t.ticketId || t.id,
      name: t.ticketName || t.name,
      category: t.ticketCategory || t.category || null,
      price: Number(t.price || 0),
    })),
    rules,
  });
});

// ----- Admin: edit per-event rules (option 3B) -----
app.get('/api/admin/booking-event-rules/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const base = await getEventById(id);
  if (!base) return res.status(404).json({ error: 'Event not found.' });

  const rulesMap = getEventRulesFromFile();
  const rulesKey = base.id || id;
  const rules = normalizeEventRules(rulesMap[rulesKey] || rulesMap[id] || null);

  res.json({ event: { id: base.id, name: base.name }, rules });
});

app.put('/api/admin/booking-event-rules/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const base = await getEventById(id);
  if (!base) return res.status(404).json({ error: 'Event not found.' });

  const rulesMap = getEventRulesFromFile();
  const rulesKey = base.id || id;
  const normalized = normalizeEventRules(req.body);
  rulesMap[rulesKey] = normalized;
  const ok = setEventRulesToFile(rulesMap);
  if (!ok) return res.status(500).json({ error: 'Could not save rules.' });

  res.json({ success: true, rules: normalized });
});

// ----- Auth (email/password, session cookie w/ JWT) -----
app.get('/api/auth/me', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const user = await getAuthUserFromRequest(req);
  if (!user) return res.json({ user: null });

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, created_at, payment_method, price_paid, status, event_id, events(name, date, time, venue, image, description, price)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const safeBookings = Array.isArray(bookings) ? bookings : [];
  const eventIds = safeBookings.map((b) => b.event_id).filter(Boolean);

  let attendeeTicketsByEventId = new Map();
  if (eventIds.length) {
    const { data: attendeeRows } = await supabase
      .from('attendees')
      .select('event_id, ticket_id, ticket_number, ticket_category')
      .eq('email', String(user.email || '').trim().toLowerCase())
      .in('event_id', eventIds);

    for (const row of attendeeRows || []) {
      if (row && row.event_id && row.ticket_id) {
        const prev = attendeeTicketsByEventId.get(row.event_id) || [];
        prev.push({
          ticketId: row.ticket_id,
          ticketNumber: row.ticket_number,
          ticketCategory: row.ticket_category,
        });
        attendeeTicketsByEventId.set(row.event_id, prev);
      }
    }
  }

  const instapayPending = safeBookings.filter((b) => b.payment_method === 'instapay' && b.status === 'pending_payment');
  const instapayQrByBookingId = {};
  await Promise.all(
    instapayPending.map(async (b) => {
      try {
        instapayQrByBookingId[b.id] = await generateInstapayQrDataUrl(getPaymentRefForBooking(b.id));
      } catch {
        instapayQrByBookingId[b.id] = '';
      }
    })
  );

  res.json({
    user,
    bookedEvents: safeBookings.map((b) => {
      const event = b.events
        ? {
            id: b.event_id,
            name: b.events.name,
            date: b.events.date,
            time: b.events.time,
            venue: b.events.venue,
            image: b.events.image,
            description: b.events.description,
            price: Number(b.events.price || 0),
            type: Number(b.events.price || 0) > 0 ? 'paid' : 'free',
          }
        : null;

      const paymentStatus =
        b.status === 'paid' || b.status === 'confirmed' ? 'Paid' : b.status === 'pending_payment' ? 'Pending' : String(b.status || 'Pending');

      const tickets =
        paymentStatus === 'Paid' ? attendeeTicketsByEventId.get(b.event_id) || [] : [];
      const ticketId = tickets.length ? tickets[0].ticketId : null;
      const ticketIds = tickets.map((t) => t.ticketId);

      return {
        id: b.id,
        status: b.status,
        paymentMethod: b.payment_method,
        paymentStatus,
        paymentQrDataUrl: instapayQrByBookingId[b.id] || null,
        ticketId,
        ticketIds,
        pricePaid: Number(b.price_paid || 0),
        createdAt: b.created_at,
        event,
      };
    }),
  });
});

app.post('/api/auth/signup', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const profilePictureUrl = String(req.body?.profilePictureUrl || '').trim() || null;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('app_users')
    .insert({ name: name || null, email, password_hash: passwordHash, profile_picture_url: profilePictureUrl })
    .select('id, name, email, profile_picture_url, created_at')
    .single();

  if (error) {
    console.error('Supabase signup insert error:', error.message);
    const msg = error.message && error.message.toLowerCase().includes('duplicate')
      ? 'Email is already registered.'
      : 'Could not create account.';
    // In dev we return the underlying message to make schema issues obvious.
    if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      return res.status(400).json({ error: msg + ' ' + error.message });
    }
    return res.status(400).json({ error: msg });
  }

  const token = signSessionToken({ id: data.id, email: data.email });
  setSessionCookie(res, token);
  res.json({ user: data });
});

app.post('/api/auth/login', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const { data: user, error } = await supabase
    .from('app_users')
    .select('id, name, email, password_hash, profile_picture_url, created_at')
    .eq('email', email)
    .maybeSingle();
  if (error || !user) return res.status(400).json({ error: 'Invalid email or password.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Invalid email or password.' });

  const token = signSessionToken({ id: user.id, email: user.email });
  setSessionCookie(res, token);
  const safeUser = { id: user.id, name: user.name, email: user.email, profile_picture_url: user.profile_picture_url, created_at: user.created_at };
  res.json({ user: safeUser });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.patch('/api/auth/profile', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const name = String(req.body?.name ?? '').trim() || null;
  const profilePictureUrl = String(req.body?.profilePictureUrl ?? '').trim() || null;
  const { data, error } = await supabase
    .from('app_users')
    .update({ name, profile_picture_url: profilePictureUrl, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select('id, name, email, profile_picture_url, created_at')
    .single();
  if (error) return res.status(500).json({ error: 'Could not update profile.' });
  res.json({ user: data });
});

// Google OAuth (redirect + callback)
// Requires env:
// - GOOGLE_OAUTH_CLIENT_ID
// - GOOGLE_OAUTH_CLIENT_SECRET
// - GOOGLE_OAUTH_REDIRECT_URI
app.get('/api/auth/google/start', async (req, res) => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  const next = String(req.query.next || '/profile');

  if (!clientId || !clientSecret || !redirectUri) {
    // Redirect back to auth page with a friendly message.
    return res.redirect('/auth?error=google_not_configured');
  }

  const state = crypto.randomBytes(18).toString('hex');
  res.cookie('google_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });
  res.cookie('google_oauth_next', next, {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'consent',
    state,
  });

  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.redirect('/auth?error=google_not_configured');
  }

  const code = String(req.query.code || '').trim();
  const state = String(req.query.state || '').trim();

  const expectedState = req.cookies?.google_oauth_state || '';
  if (!code || !state || state !== expectedState) {
    return res.redirect('/auth?error=google_state_invalid');
  }

  const next = req.cookies?.google_oauth_next || '/profile';

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2Client.getToken(code);

  const idToken = tokens?.id_token;
  if (!idToken) {
    return res.redirect('/auth?error=google_id_token_missing');
  }

  const ticket = await oauth2Client.verifyIdToken({
    idToken,
    audience: clientId,
  });

  const payload = ticket?.getPayload?.();
  const email = String(payload?.email || '').trim().toLowerCase();
  const name = String(payload?.name || '').trim() || null;
  const picture = String(payload?.picture || '').trim() || null;

  if (!email) {
    return res.redirect('/auth?error=google_email_missing');
  }

  if (!supabase) {
    return res.redirect('/auth?error=supabase_not_configured');
  }

  // Upsert user into our app_users table
  // For Google-created users, password login won't work until we add a flow,
  // but booking/checkouts work through the OAuth session cookie.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const { data: existing, error: findError } = await supabase
    .from('app_users')
    .select('id, email, name, profile_picture_url')
    .eq('email', email)
    .maybeSingle();

  if (findError) {
    return res.redirect('/auth?error=google_user_lookup_failed');
  }

  let userRow = existing;
  if (!existing) {
    const { data: inserted } = await supabase
      .from('app_users')
      .insert({ name, email, password_hash: passwordHash, profile_picture_url: picture })
      .select('id, name, email, profile_picture_url, created_at')
      .single();
    userRow = inserted;
  } else {
    // Update profile fields if we got them
    await supabase
      .from('app_users')
      .update({
        name: name || existing.name || null,
        profile_picture_url: picture || existing.profile_picture_url || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
  }

  const token = signSessionToken({ id: userRow.id, email: userRow.email });
  setSessionCookie(res, token);

  res.clearCookie('google_oauth_state', { path: '/' });
  res.clearCookie('google_oauth_next', { path: '/' });

  res.redirect(next);
});


// ----- Cart -----
async function getCartForUser(userId) {
  let { data, error } = await supabase
    .from('cart_items')
    .select('event_id, created_at, ticket_selections, events(id, name, date, time, venue, image, description, price)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  // Backward-compat for old schema (before ticket_selections column)
  if (error && String(error.message || '').toLowerCase().includes('ticket_selections')) {
    ({ data, error } = await supabase
      .from('cart_items')
      .select('event_id, created_at, events(id, name, date, time, venue, image, description, price)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }));
  }

  if (error) throw error;

  const items = (data || [])
    .map((row) => {
      const unitEventPrice = Number(row.events?.price || 0);
      const rawSelections = row.ticket_selections;
      const ticketSelections = Array.isArray(rawSelections) ? rawSelections : [];
      const normalizedSelections = (ticketSelections || [])
        .map((s) => {
          const qty = Math.max(0, parseInt(s.quantity ?? s.qty ?? 1, 10) || 0);
          const unitPrice = Number(s.unitPrice ?? s.price ?? unitEventPrice);
          return {
            ticketId: String(s.ticketId ?? s.id ?? 'default'),
            ticketName: String(s.ticketName ?? s.name ?? 'Ticket'),
            ticketCategory: s.ticketCategory != null ? String(s.ticketCategory) : s.category != null ? String(s.category) : null,
            unitPrice: Number.isFinite(unitPrice) ? unitPrice : unitEventPrice,
            quantity: qty,
          };
        })
        .filter((s) => s.ticketId && s.quantity > 0);

      const effectiveSelections =
        normalizedSelections.length > 0
          ? normalizedSelections
          : [
              {
                ticketId: 'default',
                ticketName: 'General Admission',
                ticketCategory: null,
                unitPrice: unitEventPrice,
                quantity: 1,
              },
            ];

      const selectionsTotal = effectiveSelections.reduce(
        (sum, s) => sum + Number(s.unitPrice || 0) * Number(s.quantity || 0),
        0
      );

      return {
        eventId: row.event_id,
        addedAt: row.created_at,
        event: row.events
          ? {
              id: row.events.id,
              name: row.events.name,
              date: row.events.date,
              time: row.events.time,
              venue: row.events.venue,
              image: row.events.image,
              description: row.events.description,
              price: unitEventPrice,
              type: unitEventPrice > 0 ? 'paid' : 'free',
            }
          : null,
        ticketSelections: effectiveSelections,
        selectionsTotal,
        // Keep legacy field so existing UI doesn't crash
        price: selectionsTotal,
      };
    })
    .filter((i) => i.event);

  const total = items.reduce((sum, i) => sum + Number(i.selectionsTotal || 0), 0);
  return { items, total };
}

app.get('/api/cart', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  try {
    const cart = await getCartForUser(user.id);
    res.json(cart);
  } catch (e) {
    console.error('Cart read error:', e.message);
    res.status(500).json({ error: 'Could not load cart.' });
  }
});

app.post('/api/cart/add', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const eventId = String(req.body?.eventId || '').trim();
  if (!eventId) return res.status(400).json({ error: 'eventId is required.' });

  const eventRow = await resolveEventRowByIdOrSlug(eventId);
  if (!eventRow) return res.status(404).json({ error: 'Event not found.' });

  const { error } = await supabase
    .from('cart_items')
    .upsert({ user_id: user.id, event_id: eventRow.id }, { onConflict: 'user_id,event_id' });
  if (error) return res.status(500).json({ error: 'Could not add to cart.' });

  const cart = await getCartForUser(user.id);
  res.json(cart);
});

// Add/update a specific ticket category + quantity for an event in the cart.
// Cart still remains "one row per user+event", while ticket selections are stored in ticket_selections JSONB.
app.post('/api/cart/add-ticket', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  const eventId = String(req.body?.eventId || '').trim();
  const ticketId = String(req.body?.ticketId || req.body?.ticket_id || 'default').trim();
  const ticketName = String(req.body?.ticketName || req.body?.ticket_name || 'Ticket').trim();
  const ticketCategory = req.body?.ticketCategory != null ? String(req.body.ticketCategory).trim() : req.body?.category != null ? String(req.body.category).trim() : null;
  const quantity = Math.max(0, parseInt(req.body?.quantity ?? req.body?.qty ?? 1, 10) || 0);

  if (!eventId) return res.status(400).json({ error: 'eventId is required.' });
  if (!ticketId) return res.status(400).json({ error: 'ticketId is required.' });
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be >= 1.' });

  // Resolve event so we can store FK UUID in cart_items.event_id.
  const eventRow = await resolveEventRowByIdOrSlug(eventId);
  if (!eventRow) return res.status(404).json({ error: 'Event not found.' });

  const unitPrice = Number.isFinite(Number(req.body?.unitPrice ?? req.body?.price))
    ? Number(req.body?.unitPrice ?? req.body?.price)
    : Number(eventRow.price || 0);

  const { data: existing, error: fetchError } = await supabase
    .from('cart_items')
    .select('ticket_selections')
    .eq('user_id', user.id)
    .eq('event_id', eventRow.id)
    .maybeSingle();

  if (fetchError) return res.status(500).json({ error: 'Could not load cart selections.' });

  const existingSelections = Array.isArray(existing?.ticket_selections) ? existing.ticket_selections : [];
  const updated = [...existingSelections];

  const idx = updated.findIndex((s) => String(s.ticketId ?? s.id ?? '') === ticketId);
  const nextSelection = {
    ticketId,
    ticketName,
    ticketCategory: ticketCategory || null,
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
    quantity,
  };

  if (idx >= 0) updated[idx] = nextSelection;
  else updated.push(nextSelection);

  const { error: upsertError } = await supabase.from('cart_items').upsert(
    {
      user_id: user.id,
      event_id: eventRow.id,
      ticket_selections: updated,
    },
    { onConflict: 'user_id,event_id' }
  );

  if (upsertError) return res.status(500).json({ error: 'Could not add ticket to cart.' });

  const cart = await getCartForUser(user.id);
  res.json(cart);
});

app.post('/api/cart/remove', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const eventId = String(req.body?.eventId || '').trim();
  if (!eventId) return res.status(400).json({ error: 'eventId is required.' });
  const eventRow = await resolveEventRowByIdOrSlug(eventId);
  if (!eventRow) return res.status(404).json({ error: 'Event not found.' });

  const { error } = await supabase
    .from('cart_items')
    .delete()
    .eq('user_id', user.id)
    .eq('event_id', eventRow.id);
  if (error) return res.status(500).json({ error: 'Could not remove from cart.' });
  const cart = await getCartForUser(user.id);
  res.json(cart);
});

app.post('/api/cart/clear', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const { error } = await supabase.from('cart_items').delete().eq('user_id', user.id);
  if (error) return res.status(500).json({ error: 'Could not clear cart.' });
  res.json({ ok: true });
});

// ----- Checkout + mocked payments -----
async function findAlreadyBookedEventIds(userId, eventIds) {
  if (!eventIds.length) return [];
  const { data, error } = await supabase
    .from('bookings')
    .select('event_id')
    .eq('user_id', userId)
    .in('event_id', eventIds);
  if (error) throw error;
  return (data || []).map((r) => r.event_id);
}

async function confirmBookingsFromCart(userId, paymentMethod, pricePaidByEventId) {
  const cart = await getCartForUser(userId);
  const eventIds = cart.items.map((i) => i.eventId);
  const alreadyBooked = await findAlreadyBookedEventIds(userId, eventIds);
  if (alreadyBooked.length) {
    return { error: 'Some events in your cart are already booked.', alreadyBooked };
  }

  const rows = cart.items.map((i) => ({
    user_id: userId,
    event_id: i.eventId,
    payment_method: paymentMethod,
    price_paid: Number(pricePaidByEventId?.[i.eventId] ?? i.price ?? 0),
    status: 'confirmed',
  }));
  if (rows.length === 0) return { ok: true, booked: 0, total: 0 };

  const { error } = await supabase.from('bookings').insert(rows);
  if (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      return { error: 'You already booked one of these events.' };
    }
    console.error('Booking insert error:', error.message);
    return { error: 'Could not confirm booking.' };
  }

  await supabase.from('cart_items').delete().eq('user_id', userId);
  return { ok: true, booked: rows.length, total: cart.total };
}

app.post('/api/checkout/start', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  const cart = await getCartForUser(user.id);
  if (cart.items.length === 0) return res.status(400).json({ error: 'Cart is empty.' });

  // Free checkout: skip payment
  if (cart.total <= 0) {
    const result = await confirmBookingsFromCart(user.id, 'free', {});
    if (result.error) return res.status(400).json(result);
    return res.json({ status: 'confirmed', ...result });
  }

  const sessionItems = cart.items.map((i) => ({
    eventId: i.eventId,
    name: i.event.name,
    price: Number(i.price || 0),
  }));
  const { data, error } = await supabase
    .from('checkout_sessions')
    .insert({
      user_id: user.id,
      status: 'pending',
      amount_total: Number(cart.total || 0),
      items: sessionItems,
    })
    .select('id, amount_total')
    .single();
  if (error) return res.status(500).json({ error: 'Could not start checkout.' });

  res.json({
    status: 'payment_required',
    sessionId: data.id,
    amountTotal: Number(data.amount_total || 0),
    redirectUrl: `/payment?session=${encodeURIComponent(data.id)}`,
  });
});

// New unified checkout confirm endpoint (used by the updated Checkout UI)
app.post('/api/checkout/confirm', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const methodRaw = String(req.body?.method || '').trim().toLowerCase();
  const method = methodRaw || 'card';

  const cart = await getCartForUser(user.id);
  if (!cart.items.length) return res.status(400).json({ error: 'Cart is empty.' });

  const eventIds = cart.items.map((i) => i.eventId);
  const alreadyBooked = await findAlreadyBookedEventIds(user.id, eventIds);
  if (alreadyBooked.length) {
    return res.status(400).json({ error: 'You already booked one or more events.', alreadyBooked });
  }

  // Free checkout
  if (cart.total <= 0) {
    const rows = cart.items.map((i) => ({
      user_id: user.id,
      event_id: i.eventId,
      payment_method: 'free',
      price_paid: Number(i.selectionsTotal || i.price || 0),
      ticket_selections: i.ticketSelections || [],
      status: 'paid',
    }));

    const { data: inserted, error } = await supabase.from('bookings').insert(rows).select('id, event_id');
    if (error) return res.status(400).json({ error: 'Could not confirm booking.' });

    await supabase.from('cart_items').delete().eq('user_id', user.id);

    // Create QR tickets + send one email with multiple QR codes
    const insertedRows = inserted || [];
    for (let idx = 0; idx < insertedRows.length; idx++) {
      const b = insertedRows[idx];
      const item = cart.items.find((it) => it.eventId === b.event_id);
      if (!item) continue;

      let ticketCounter = 1;
      const ticketsForEmail = [];

      for (const selection of item.ticketSelections || []) {
        const qty = Math.max(0, Number(selection.quantity || 0));
        for (let q = 0; q < qty; q++) {
          const ticketId = await getUniqueShortTicketId();
          const ticketNumber = String(ticketCounter++);
          const ticketCategory = selection.ticketCategory || selection.ticketName || null;

          await insertAttendeeForBooking({
            name: user.name || 'Customer',
            email: user.email,
            eventId: item.eventId,
            eventName: item.event.name,
            ticketId,
            ticketCategory,
            ticketNumber,
          });

          ticketsForEmail.push({
            ticketId,
            ticketNumber,
            ticketCategory,
          });
        }
      }

      try {
        await sendTicketsEmailToUserMulti({
          toEmail: user.email,
          name: user.name || 'Customer',
          eventName: item.event.name,
          tickets: ticketsForEmail,
        });
      } catch (e) {}
    }

    return res.json({ status: 'paid', paymentMethod: 'free', booked: insertedRows.map((r) => r.id) });
  }

  if (method !== 'instapay' && method !== 'visa' && method !== 'card' && method !== 'applepay' && method !== 'credit' && method !== 'debit') {
    return res.status(400).json({ error: 'Invalid payment method.' });
  }

  // Normalize method to the values used by the UI + admin
  const normalizedMethod = method === 'applepay' ? 'applepay' : method === 'instapay' ? 'instapay' : 'card';
  const isInsta = normalizedMethod === 'instapay';

  const rows = cart.items.map((i) => ({
    user_id: user.id,
    event_id: i.eventId,
    payment_method: normalizedMethod,
    price_paid: Number(i.selectionsTotal || i.price || 0),
    ticket_selections: i.ticketSelections || [],
    status: isInsta ? 'pending_payment' : 'paid',
  }));

  const { data: inserted, error } = await supabase.from('bookings').insert(rows).select('id, event_id');
  if (error) return res.status(400).json({ error: 'Could not process checkout.' });

  // Clear cart regardless of payment method: tickets will be created on payment confirmation for InstaPay.
  await supabase.from('cart_items').delete().eq('user_id', user.id);

  if (isInsta) {
    return res.json({ status: 'pending_payment', bookingIds: (inserted || []).map((r) => r.id) });
  }

  // Paid (card / applepay) => create ticket QR + email immediately
  const insertedRows = inserted || [];
  for (let idx = 0; idx < insertedRows.length; idx++) {
    const b = insertedRows[idx];
    const item = cart.items.find((it) => it.eventId === b.event_id);
    if (!item) continue;

    let ticketCounter = 1;
    const ticketsForEmail = [];

    for (const selection of item.ticketSelections || []) {
      const qty = Math.max(0, Number(selection.quantity || 0));
      for (let q = 0; q < qty; q++) {
        const ticketId = await getUniqueShortTicketId();
        const ticketNumber = String(ticketCounter++);
        const ticketCategory = selection.ticketCategory || selection.ticketName || null;

        await insertAttendeeForBooking({
          name: user.name || 'Customer',
          email: user.email,
          eventId: item.eventId,
          eventName: item.event.name,
          ticketId,
          ticketCategory,
          ticketNumber,
        });

        ticketsForEmail.push({
          ticketId,
          ticketNumber,
          ticketCategory,
        });
      }
    }

    try {
      await sendTicketsEmailToUserMulti({
        toEmail: user.email,
        name: user.name || 'Customer',
        eventName: item.event.name,
        tickets: ticketsForEmail,
      });
    } catch (e) {}
  }

  return res.json({ status: 'paid', paymentMethod: normalizedMethod, booked: insertedRows.map((r) => r.id) });
});

app.get('/api/checkout/session/:id', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const id = String(req.params.id || '').trim();
  const { data, error } = await supabase
    .from('checkout_sessions')
    .select('id, status, payment_method, amount_total, items, created_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Session not found.' });
  res.json({
    id: data.id,
    status: data.status,
    paymentMethod: data.payment_method,
    amountTotal: Number(data.amount_total || 0),
    items: data.items || [],
    createdAt: data.created_at,
  });
});

app.post('/api/payments/confirm', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const sessionId = String(req.body?.sessionId || '').trim();
  const method = String(req.body?.method || '').trim().toLowerCase();
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  if (method !== 'visa' && method !== 'instapay') return res.status(400).json({ error: 'Invalid payment method.' });

  const { data: session, error } = await supabase
    .from('checkout_sessions')
    .select('id, status, amount_total, items')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !session) return res.status(404).json({ error: 'Session not found.' });
  if (session.status !== 'pending') return res.status(400).json({ error: 'Session is not pending.' });

  // Simulate success flow
  const result = await confirmBookingsFromCart(user.id, method, {});
  if (result.error) return res.status(400).json(result);

  await supabase
    .from('checkout_sessions')
    .update({ status: 'succeeded', payment_method: method, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', user.id);

  res.json({ status: 'succeeded', ...result });
});

// InstaPay QR for a specific pending booking (used by user profile + success UI)
app.get('/api/bookings/instapay-qr/:bookingId', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const bookingId = String(req.params.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required.' });

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, user_id, status, payment_method')
    .eq('id', bookingId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.payment_method !== 'instapay' || booking.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Booking is not pending InstaPay.' });
  }

  const paymentRef = getPaymentRefForBooking(booking.id);
  const qrDataUrl = await generateInstapayQrDataUrl(paymentRef);
  res.json({ bookingId: booking.id, paymentRef, qrDataUrl });
});

// ----- Admin: InstaPay bookings listing + manual confirmation -----
app.get('/api/admin/instapay-bookings', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.json([]);

  const statusRaw = String(req.query.status || '').trim().toLowerCase();
  const status =
    statusRaw === 'pending' || statusRaw === 'pending_payment' ? 'pending_payment' : statusRaw === 'paid' ? 'paid' : null;

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('id, user_id, event_id, status, payment_method, price_paid, ticket_selections, created_at')
    .eq('payment_method', 'instapay');

  if (error) return res.status(500).json({ error: 'Could not load InstaPay bookings.' });

  const filtered = status ? (bookings || []).filter((b) => b.status === status) : bookings || [];
  const userIds = [...new Set(filtered.map((b) => b.user_id).filter(Boolean))];
  const eventIds = [...new Set(filtered.map((b) => b.event_id).filter(Boolean))];

  const { data: users } = userIds.length
    ? await supabase.from('app_users').select('id, name, email, profile_picture_url').in('id', userIds)
    : { data: [] };
  const { data: events } = eventIds.length
    ? await supabase.from('events').select('id, name, date, time, venue, image, description, price').in('id', eventIds)
    : { data: [] };

  const userById = new Map((users || []).map((u) => [u.id, u]));
  const eventById = new Map((events || []).map((e) => [e.id, e]));

  res.json(
    filtered.map((b) => ({
      id: b.id,
      status: b.status,
      pricePaid: Number(b.price_paid || 0),
      ticketsCount: Array.isArray(b.ticket_selections)
        ? b.ticket_selections.reduce((sum, s) => sum + Number(s.quantity || 0), 0)
        : 0,
      createdAt: b.created_at,
      user: userById.get(b.user_id) || null,
      event: eventById.get(b.event_id) || null,
    }))
  );
});

app.post('/api/admin/instapay-bookings/:bookingId/confirm', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const bookingId = String(req.params.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required.' });

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, user_id, event_id, status, payment_method, price_paid, ticket_selections')
    .eq('id', bookingId)
    .maybeSingle();

  if (error || !booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.payment_method !== 'instapay' || booking.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Booking is not pending InstaPay.' });
  }

  const { data: user } = await supabase.from('app_users').select('id, name, email').eq('id', booking.user_id).maybeSingle();
  const { data: event } = await supabase.from('events').select('id, name').eq('id', booking.event_id).maybeSingle();
  if (!user || !event) return res.status(400).json({ error: 'User or event not found.' });

  const selections = Array.isArray(booking.ticket_selections) ? booking.ticket_selections : [];
  const normalizedSelections =
    selections.length > 0
      ? selections
      : [
          {
            ticketId: 'default',
            ticketName: 'Ticket',
            ticketCategory: null,
            unitPrice: 0,
            quantity: 1,
          },
        ];

  let ticketCounter = 1;
  const ticketsForEmail = [];

  for (const selection of normalizedSelections) {
    const qty = Math.max(0, Number(selection.quantity || 0));
    for (let q = 0; q < qty; q++) {
      const ticketId = await getUniqueShortTicketId();
      const ticketNumber = String(ticketCounter++);
      const ticketCategory = selection.ticketCategory || selection.ticketName || null;

      await insertAttendeeForBooking({
        name: user.name || 'Customer',
        email: user.email,
        eventId: booking.event_id,
        eventName: event.name,
        ticketId,
        ticketCategory,
        ticketNumber,
      });

      ticketsForEmail.push({
        ticketId,
        ticketNumber,
        ticketCategory,
      });
    }
  }

  try {
    await sendTicketsEmailToUserMulti({
      toEmail: user.email,
      name: user.name || 'Customer',
      eventName: event.name,
      tickets: ticketsForEmail,
    });
  } catch (e) {}

  const { error: updateError } = await supabase
    .from('bookings')
    .update({ status: 'paid' })
    .eq('id', bookingId);

  if (updateError) return res.status(500).json({ error: 'Could not confirm payment.' });
  res.json({
    success: true,
    ticketId: ticketsForEmail[0]?.ticketId || null,
    ticketIds: ticketsForEmail.map((t) => t.ticketId),
  });
});

// Admin dashboard page (simple, protect via ADMIN_API_KEY for API calls)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin-bookings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-bookings.html'));
});

app.get('/admin-rules', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-booking-event-rules.html'));
});

// TicketsMarche-style routes
app.get('/event/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

app.get('/event/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'event-details.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/event', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'event.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/api/register', async (req, res) => {
  const { name, email, phone, eventId } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const event = eventId ? await getEventById(eventId) : null;
  const eventName = event ? event.name : (process.env.EVENT_NAME || 'Event');
  const blocked = await isUserBlocked(email.trim(), (phone || '').trim());
  if (blocked) {
    return res.status(403).json({ error: 'This email or phone is blocked from registering.' });
  }
  const existing = await findExistingRegistration(email.trim(), (phone || '').trim(), eventId || null, eventName);
  if (existing) {
    if (existing.type === 'email') {
      return res.status(400).json({ error: 'This email is already registered for this event.' });
    }
    return res.status(400).json({ error: 'This phone number is already registered for this event.' });
  }
  const ticketId = await getUniqueShortTicketId();
  try {
    await appendAttendee(name.trim(), email.trim(), (phone || '').trim(), ticketId, eventName);
  } catch (e) {
    console.error('Sheet append error:', e.message);
    // Continue anyway in demo mode
  }

  // Also save to Supabase (if configured)
  try {
    await saveAttendeeToSupabase({
      name: name.trim(),
      email: email.trim(),
      phone: (phone || '').trim(),
      ticketId,
      eventId,
      eventName,
    });
  } catch (e) {
    console.error('Supabase save error:', e.message);
  }

  const { dataUrl, buffer, checkInUrl } = await generateQR(ticketId);

  const skipNodeEmail = String(process.env.EMAIL_VIA_SUPABASE || '').toLowerCase() === 'true';
  let emailSent = false;
  if (!skipNodeEmail) {
    const transporter = getTransporter();
    if (transporter) {
      try {
        const toEmail = email.trim();
        const html = buildTicketEmailHtml({
          name: (name || '').trim(),
          eventName,
          ticketId,
          dataUrl,
          checkInUrl: `${BASE_URL}/checkin/${ticketId}`,
        });
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: toEmail,
          subject: `Your ticket for ${eventName}`,
          html,
          attachments: [
            { filename: 'ticket-qr.png', content: buffer, cid: 'ticket-qr' },
          ],
        });
        emailSent = true;
        console.log(`Ticket email sent to ${toEmail} for ${eventName}`);
      } catch (err) {
        console.error('Email send failed:', err.message);
        console.error('To:', email.trim(), '| Event:', eventName);
        if (err.code) console.error('Error code:', err.code);
        if (err.response) console.error('Response:', err.response);
        // Don't fail registration – user gets ticket on page instead
      }
    }
  }

  const eventDate = event ? event.date : null;
  const eventTime = event ? event.time : null;
  // Expiry: one day after the event date
  let eventExpiry = null;
  if (eventDate) {
    const d = new Date(eventDate);
    d.setDate(d.getDate() + 1);
    eventExpiry = d.toISOString().slice(0, 10);
  }

  res.json({
    success: true,
    message: emailSent ? 'Registered! Check your email for your ticket (also check spam/junk folder).' : 'Registered! Your ticket is below.',
    emailSent,
    ticketId,
    ticketUrl: `${BASE_URL}/ticket/${ticketId}`,
    myTicketsUrl: `${BASE_URL}/my-tickets?email=${encodeURIComponent((req.body?.email || '').trim())}`,
    qrDataUrl: dataUrl,
    eventName,
    eventDate,
    eventTime,
    eventExpiry,
  });
});

// ----- Site config (footer, etc.) – file-based -----
const SITE_CONFIG_PATH = path.join(__dirname, 'public', 'site-config.json');

function getSiteConfig() {
  try {
    const raw = fs.readFileSync(SITE_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {
      copyright: '© BLOCK',
      instagramUrl: 'https://www.instagram.com/blockagency.eg',
      instagramLabel: 'Instagram',
      links: [
        { label: 'My tickets', url: '/my-tickets' },
        { label: 'Events', url: '/events' },
        { label: 'Contact', url: '/contact' },
      ],
    };
  }
}

app.get('/api/site-config', (req, res) => {
  res.json(getSiteConfig());
});

app.put('/api/admin/site-config', (req, res) => {
  // Local dev convenience: allow localhost without key
  if (!isLocalhostRequest(req)) {
    if (!process.env.ADMIN_API_KEY) {
      return res.status(503).json({ error: 'ADMIN_API_KEY not set on server.' });
    }
    if (!isAdminRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  }
  const body = req.body || {};
  const config = {
    copyright: (body.copyright || '© BLOCK').trim(),
    instagramUrl: (body.instagramUrl || '').trim() || 'https://www.instagram.com/blockagency.eg',
    instagramLabel: (body.instagramLabel || 'Instagram').trim(),
    links: Array.isArray(body.links)
      ? body.links
          .filter((l) => l && (l.label || l.url))
          .map((l) => ({ label: String(l.label || '').trim(), url: String(l.url || '').trim() }))
      : getSiteConfig().links,
  };
  try {
    fs.writeFileSync(SITE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json(config);
  } catch (e) {
    console.error('Site config write error:', e.message);
    res.status(500).json({ error: 'Could not save site config.' });
  }
});

// ----- Admin events API (Supabase-backed) -----

app.get('/api/admin/events', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.json(loadAdminEventsFromFile());
  try {
    const { data, error } = await supabase
      .from('events')
      .select('id, slug, name, date, time, venue, category, image, description, price, sort_order, available_tickets, created_at')
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Supabase admin list events error:', error.message);
      return res.json(loadAdminEventsFromFile());
    }
    res.json(data || []);
  } catch (e) {
    console.error('Supabase admin list events exception:', e.message);
    res.json(loadAdminEventsFromFile());
  }
});

app.post('/api/admin/events', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { name, slug, date, time, venue, category, image, description, available_tickets, price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const normalizedPrice = price != null && price !== '' ? Number(price) : 0;
  const normalizedAvailable = available_tickets != null && available_tickets !== '' ? parseInt(available_tickets, 10) : null;
  if (!supabase) {
    const events = getEventsFromFile();
    const newEvent = {
      id: uuidv4(),
      slug: slug || null,
      name: String(name || '').trim(),
      date: date || null,
      time: time || null,
      venue: venue || null,
      category: category || null,
      image: image || null,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
    };
    events.push(newEvent);
    setEventsToFile(events);
    return res.json({ id: newEvent.id, slug: newEvent.slug });
  }

  try {
    const payload = {
      name,
      slug: slug || null,
      date: date || null,
      time: time || null,
      venue: venue || null,
      category: category || null,
      image: image || null,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
    };
    const { data, error } = await supabase
      .from('events')
      .insert(payload)
      .select('id, slug')
      .single();
    if (error) {
      console.error('Supabase admin create event error:', error.message);
      const events = getEventsFromFile();
      const newEvent = {
        id: uuidv4(),
        slug: slug || null,
        name: String(name || '').trim(),
        date: date || null,
        time: time || null,
        venue: venue || null,
        category: category || null,
        image: image || null,
        description: description || null,
        price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
        available_tickets: normalizedAvailable,
      };
      events.push(newEvent);
      setEventsToFile(events);
      return res.json({ id: newEvent.id, slug: newEvent.slug });
    }
    res.json(data);
  } catch (e) {
    console.error('Supabase admin create event exception:', e.message);
    const events = getEventsFromFile();
    const newEvent = {
      id: uuidv4(),
      slug: slug || null,
      name: String(name || '').trim(),
      date: date || null,
      time: time || null,
      venue: venue || null,
      category: category || null,
      image: image || null,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
    };
    events.push(newEvent);
    setEventsToFile(events);
    res.json({ id: newEvent.id, slug: newEvent.slug });
  }
});

app.put('/api/admin/events/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { id } = req.params;
  const { name, slug, date, time, venue, category, image, description, available_tickets, price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const normalizedPrice = price != null && price !== '' ? Number(price) : 0;
  const normalizedAvailable = available_tickets != null && available_tickets !== '' ? parseInt(available_tickets, 10) : null;
  if (!supabase) {
    const events = getEventsFromFile();
    const idx = events.findIndex((e) => e && e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Event not found.' });
    events[idx] = {
      ...(events[idx] || {}),
      slug: slug || null,
      name: String(name || '').trim(),
      date: date || null,
      time: time || null,
      venue: venue || null,
      category: category || null,
      image: image || null,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
    };
    setEventsToFile(events);
    return res.json({ id: events[idx].id, slug: events[idx].slug || null });
  }

  try {
    const payload = {
      name,
      slug: slug || null,
      date: date || null,
      time: time || null,
      venue: venue || null,
      category: category || null,
      image: image || null,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
    };
    const { data, error } = await supabase
      .from('events')
      .update(payload)
      .eq('id', id)
      .select('id, slug')
      .single();
    if (error) {
      console.error('Supabase admin update event error:', error.message);
      const events = getEventsFromFile();
      const idx = events.findIndex((e) => e && e.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Event not found.' });
      events[idx] = {
        ...(events[idx] || {}),
        slug: slug || null,
        name: String(name || '').trim(),
        date: date || null,
        time: time || null,
        venue: venue || null,
        category: category || null,
        image: image || null,
        description: description || null,
        price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
        available_tickets: normalizedAvailable,
      };
      setEventsToFile(events);
      return res.json({ id: events[idx].id, slug: events[idx].slug || null });
    }
    res.json(data);
  } catch (e) {
    console.error('Supabase admin update event exception:', e.message);
    const events = getEventsFromFile();
    const idx = events.findIndex((e) => e && e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Event not found.' });
    events[idx] = {
      ...(events[idx] || {}),
      slug: slug || null,
      name: String(name || '').trim(),
      date: date || null,
      time: time || null,
      venue: venue || null,
      category: category || null,
      image: image || null,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
    };
    setEventsToFile(events);
    res.json({ id: events[idx].id, slug: events[idx].slug || null });
  }
});

app.delete('/api/admin/events/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { id } = req.params;
  if (!supabase) {
    const events = getEventsFromFile();
    const next = (events || []).filter((e) => e && e.id !== id);
    setEventsToFile(next);
    return res.json({ success: true });
  }

  try {
    const { error } = await supabase.from('events').delete().eq('id', id);
    if (error) {
      console.error('Supabase admin delete event error:', error.message);
      const events = getEventsFromFile();
      const next = (events || []).filter((e) => e && e.id !== id);
      setEventsToFile(next);
      return res.json({ success: true });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Supabase admin delete event exception:', e.message);
    const events = getEventsFromFile();
    const next = (events || []).filter((e) => e && e.id !== id);
    setEventsToFile(next);
    res.json({ success: true });
  }
});

app.post('/api/admin/events/reorder', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of event IDs.' });
  }
  // File-based reorder (when Supabase is missing/unreachable)
  if (!supabase) {
    const events = getEventsFromFile();
    const map = new Map((events || []).map((e) => [e.id, e]));
    const next = [];
    for (const id of order) {
      if (map.has(id)) next.push(map.get(id));
    }
    // append remaining events (not included in order)
    for (const e of events || []) {
      if (e && !order.includes(e.id)) next.push(e);
    }
    setEventsToFile(next);
    return res.json({ success: true });
  }

  try {
    const updates = order.map((id, index) => ({ id, sort_order: index + 1 }));
    const { error } = await supabase.from('events').upsert(updates, { onConflict: 'id' });
    if (error) {
      console.error('Supabase admin reorder events error:', error.message);
      // fallback to file reorder
      const events = getEventsFromFile();
      const map = new Map((events || []).map((e) => [e.id, e]));
      const next = [];
      for (const id of order) {
        if (map.has(id)) next.push(map.get(id));
      }
      for (const e of events || []) {
        if (e && !order.includes(e.id)) next.push(e);
      }
      setEventsToFile(next);
      return res.json({ success: true });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Admin reorder exception:', e.message);
    // fallback to file reorder
    const events = getEventsFromFile();
    const map = new Map((events || []).map((e) => [e.id, e]));
    const next = [];
    for (const id of order) {
      if (map.has(id)) next.push(map.get(id));
    }
    for (const e of events || []) {
      if (e && !order.includes(e.id)) next.push(e);
    }
    setEventsToFile(next);
    res.json({ success: true });
  }
});

app.get('/api/admin/event-stats', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const stats = await getEventStatsForAdmin();
  res.json(stats || []);
});

// List attendees for admin, optionally filtered by eventId or eventName
app.get('/api/admin/attendees', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  const eventId = (req.query.eventId || '').toString().trim();
  const eventName = (req.query.eventName || '').toString().trim();
  try {
    let query = supabase
      .from('attendees')
      .select('id, name, email, phone, event_id, event_name, attended, checkin_time, scanned_by_name, scanned_by_phone, created_at, ticket_id')
      .order('created_at', { ascending: false });
    if (eventId) {
      query = query.eq('event_id', eventId);
    } else if (eventName) {
      query = query.eq('event_name', eventName);
    }
    const { data, error } = await query;
    if (error) {
      console.error('Supabase admin attendees error:', error.message);
      return res.status(500).json({ error: 'Could not load attendees.' });
    }
    res.json(data || []);
  } catch (e) {
    console.error('Admin attendees exception:', e.message);
    res.status(500).json({ error: 'Could not load attendees.' });
  }
});

// Delete attendee – removes from DB as if they never registered
app.delete('/api/admin/attendees/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  const { id } = req.params;
  const { error } = await supabase.from('attendees').delete().eq('id', id);
  if (error) {
    console.error('Delete attendee error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// Block user – prevents them from registering in any event
app.post('/api/admin/attendees/:id/block', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  const { id } = req.params;
  const { data: attendee, error: fetchError } = await supabase
    .from('attendees')
    .select('email, phone')
    .eq('id', id)
    .maybeSingle();
  if (fetchError || !attendee) {
    return res.status(404).json({ error: 'Attendee not found.' });
  }
  const result = await blockUser(attendee.email || '', attendee.phone || '');
  if (result.error) {
    return res.status(500).json({ error: result.error });
  }
  res.json({ ok: true });
});

app.get('/api/ticket-status/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const attendee = await getAttendeeByTicketId(ticketId);
  if (!attendee) {
    return res.json({ attended: false });
  }
  res.json({ attended: !!attendee.attended });
});

app.get('/ticket/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const attendee = await getAttendeeByTicketId(ticketId);
  const attended = !!attendee?.attended;
  const { dataUrl } = await generateQR(ticketId);

  const qrScannedClass = attended ? ' qr-scanned' : '';
  const arabicLabels = attended
    ? '<span class="qr-arabic qr-arabic-left">تم مسح الرمز من قبل</span><span class="qr-arabic qr-arabic-right">تم مسح الرمز من قبل</span>'
    : '';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Your Ticket</title>
    <style>
      body { font-family: system-ui; background: #0f0f12; color: #e8e8ed; max-width: 400px; margin: 40px auto; text-align: center; padding: 20px; }
      .logo { width: 120px; height: auto; margin-bottom: 1.5rem; filter: brightness(2.4); }
      .qr-wrap { position: relative; display: inline-block; margin: 1rem 0; }
      .qr-wrap .qr-frame { position: relative; display: inline-block; padding: 12px; }
      .qr-wrap.qr-scanned .qr-frame { border: 4px solid #dc2626; border-radius: 8px; }
      .qr-arabic { position: absolute; top: 50%; transform: translateY(-50%);
        writing-mode: vertical-rl; font-size: 0.75rem; color: #fff; background: #dc2626;
        padding: 8px 4px; border-radius: 4px; white-space: nowrap; line-height: 1.2; }
      .qr-arabic-left { left: -4px; transform: translate(-100%, -50%); }
      .qr-arabic-right { right: -4px; transform: translate(100%, -50%); }
      .qr { max-width: 260px; height: auto; display: block; }
      .qr-wrap.qr-scanned .qr { filter: brightness(0.5); }
    </style>
    </head>
    <body>
      <img src="/block-logo.png" alt="BLOCK" class="logo">
      <h1>Your Ticket</h1>
      ${attended ? '<p class="qr-msg scanned" style="color:#dc2626;font-weight:600;">The code has been scanned before</p>' : '<p>Show this QR at the entrance</p>'}
      <div class="qr-wrap${qrScannedClass}">
        <div class="qr-frame">
          ${arabicLabels}
          <img src="${dataUrl}" alt="QR Code" class="qr" />
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/checkin/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const result = await markAttended(ticketId);
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Check-in</title>
    <style>
      body { font-family: system-ui; background: #0f0f12; color: #e8e8ed; max-width: 400px; margin: 40px auto; text-align: center; padding: 20px; }
      .logo { width: 120px; height: auto; margin-bottom: 1.5rem; filter: brightness(2.4); }
      .ok { color: #22c55e; }
      .fail { color: #ef4444; }
    </style>
    </head>
    <body>
      <img src="/block-logo.png" alt="BLOCK" class="logo">
      ${result.ok
        ? '<h1 class="ok">✓ Checked in!</h1><p>Welcome to the event. Enjoy!</p>'
        : '<h1 class="fail">Invalid ticket</h1><p>This ticket ID was not found.</p>'
      }
    </body>
    </html>
  `);
});

// Optional: API for scanner app to mark check-in (returns JSON). Query: scanner_name, scanner_phone.
app.get('/api/checkin/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const scannerName = (req.query.scanner_name || '').trim() || null;
  const scannerPhone = (req.query.scanner_phone || '').trim() || null;
  const attendee = await getAttendeeByTicketId(ticketId);
  if (attendee && attendee.attended) {
    return res.json({ ok: true, alreadyScanned: true });
  }
  const result = await markAttended(ticketId, scannerName, scannerPhone);
  res.json({ ...result, alreadyScanned: false });
});

// New scanning API (staff-only)
// QR content: ticket_id
app.post('/api/scan-ticket', async (req, res) => {
  if (!requireScanner(req, res)) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const ticketId = String(req.body?.ticket_id || req.body?.ticketId || '').trim();
  if (!ticketId) return res.status(400).json({ status: 'invalid', message: 'Ticket not found' });

  // Atomic "lock": update only if not used yet.
  const usedAt = new Date().toISOString();
  let updatedRow = null;
  try {
    const { data, error } = await supabase
      .from('attendees')
      .update({ attended: true, checkin_time: usedAt })
      .eq('ticket_id', ticketId)
      .eq('attended', false)
      .select('id, name, email, ticket_id, event_id, event_name, ticket_category, ticket_number, attended, checkin_time')
      .maybeSingle();
    if (!error && data) updatedRow = data;
  } catch (e) {}

  if (updatedRow) {
    return res.json({
      status: 'success',
      message: 'Scan successful',
      ticket: {
        ticket_id: updatedRow.ticket_id,
        userName: updatedRow.name,
        userEmail: updatedRow.email,
        eventName: updatedRow.event_name,
        eventId: updatedRow.event_id,
        ticketCategory: updatedRow.ticket_category,
        ticketNumber: updatedRow.ticket_number,
        isUsed: true,
        usedAt: updatedRow.checkin_time,
      },
    });
  }

  // Not updated: either ticket doesn't exist, or already used.
  const { data: existing, error: fetchError } = await supabase
    .from('attendees')
    .select('id, name, email, ticket_id, event_id, event_name, ticket_category, ticket_number, attended, checkin_time')
    .eq('ticket_id', ticketId)
    .maybeSingle();

  if (fetchError || !existing) {
    return res.json({ status: 'invalid', message: 'Ticket not found' });
  }

  if (existing.attended) {
    return res.json({
      status: 'already_used',
      message: 'Ticket already scanned',
      ticket: {
        ticket_id: existing.ticket_id,
        userName: existing.name,
        userEmail: existing.email,
        eventName: existing.event_name,
        eventId: existing.event_id,
        ticketCategory: existing.ticket_category,
        ticketNumber: existing.ticket_number,
        isUsed: true,
        usedAt: existing.checkin_time,
      },
    });
  }

  // Edge case: update failed for some other reason, treat as error.
  return res.status(500).json({ status: 'invalid', message: 'Invalid ticket' });
});

// My tickets: look up registrations by email (from Supabase)
app.get('/api/my-tickets', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.json([]);
  }
  if (!supabase) {
    return res.json([]);
  }
  const { data, error } = await supabase
    .from('attendees')
    .select('ticket_id, event_name, event_id, attended, checkin_time, created_at, name, email, phone')
    .eq('email', email)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Supabase my-tickets error:', error.message);
    return res.json([]);
  }
  res.json(data || []);
});

// Update profile (name, phone) by email – email cannot be changed; phone required
app.patch('/api/profile', async (req, res) => {
  const { email, name, phone } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  const n = String(name ?? '').trim();
  const p = String(phone ?? '').trim();
  if (!e) {
    return res.status(400).json({ error: 'Email is required.' });
  }
  if (!p) {
    return res.status(400).json({ error: 'Phone is required and cannot be empty.' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Service unavailable.' });
  }
  const { data, error } = await supabase
    .from('attendees')
    .update({ name: n || null, phone: p })
    .eq('email', e)
    .select('id');
  if (error) {
    console.error('Supabase profile update error:', error.message);
    return res.status(500).json({ error: 'Could not update profile.' });
  }
  res.json({ updated: (data && data.length) || 0 });
});

// Resend ticket QR to email (only if email matches the ticket in Supabase)
app.post('/api/resend-ticket', async (req, res) => {
  const { email, ticketId } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  const t = String(ticketId || '').trim();
  if (!e || !t) {
    return res.status(400).json({ error: 'Email and ticket ID are required.' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Service unavailable.' });
  }
  const { data: rows } = await supabase
    .from('attendees')
    .select('name, event_name')
    .eq('ticket_id', t)
    .eq('email', e)
    .limit(1);
  if (!rows || rows.length === 0) {
    return res.status(404).json({ error: 'No ticket found for this email.' });
  }
  const { name, event_name } = rows[0];
  const transporter = getTransporter();
  if (!transporter) {
    return res.status(503).json({ error: 'Email not configured. Contact support.' });
  }
  const { dataUrl, buffer } = await generateQR(t);
  const checkInUrl = `${BASE_URL}/checkin/${t}`;
  const html = buildTicketEmailHtml({
    name: name || '',
    eventName: event_name,
    ticketId: t,
    dataUrl,
    checkInUrl,
  });
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: e,
      subject: `Your ticket for ${event_name}`,
      html,
      attachments: [{ filename: 'ticket-qr.png', content: buffer }],
    });
  } catch (err) {
    console.error('Resend email error:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ success: true, message: 'Ticket sent to your email.' });
});

// Ensure sheet has header (run once or add manually)
async function ensureSheetHeaders() {
  if (!sheets || !SHEET_ID) return;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:G1`,
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1:G1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Name', 'Email', 'Phone', 'Ticket ID', 'Event', 'Attended', 'Check-in Time']] },
      });
      console.log('Sheet headers written.');
    }
  } catch (e) {
    console.warn('Could not ensure sheet headers:', e.message);
  }
}

function startServer() {
  initSheets()
    .then(() => ensureSheetHeaders())
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Event ticketing running at ${BASE_URL || `http://localhost:${PORT}`}`);
        if (getTransporter()) console.log('Email: configured – ticket emails will be sent on registration.');
        else console.warn('Email: NOT configured – set EMAIL_USER and EMAIL_APP_PASSWORD in .env to send ticket emails.');
      });
    })
    .catch((err) => {
      console.error('Startup error:', err);
      app.listen(PORT, () => {
        console.log(`Event ticketing running at http://localhost:${PORT} (no Google Sheet)`);
        if (getTransporter()) console.log('Email: configured – ticket emails will be sent on registration.');
        else console.warn('Email: NOT configured – set EMAIL_USER and EMAIL_APP_PASSWORD in .env to send ticket emails.');
      });
    });
}

if (!process.env.VERCEL) {
  startServer();
}

module.exports = app;
