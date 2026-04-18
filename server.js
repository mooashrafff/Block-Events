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
const compression = require('compression');
const sharp = require('sharp');

const fs = require('fs');
const multer = require('multer');

const app = express();
// Use 3001 by default to avoid conflicts with other apps on 3000
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

/** InstaPay (IPN): static QR asset in /public and deep link for the banking app */
const INSTAPAY_IPN_PAYMENT_URL =
  String(process.env.INSTAPAY_PAYMENT_URL || '').trim() ||
  'https://ipn.eg/S/mooashraf227/instapay/61R1wB';
const INSTAPAY_QR_IMAGE_PATH = '/instapay-ipn-qr.png';

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  console.warn('JWT_SECRET not set – auth will be insecure in production. Set JWT_SECRET in .env.');
}
// Scanner profile auth (separate env var optional; defaults to JWT_SECRET).
const SCANNER_JWT_SECRET = process.env.SCANNER_JWT_SECRET || JWT_SECRET || '';
const MAX_SCANNER_PROFILES = 50;

// ----- Supabase (for saving attendees) -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn('Supabase env vars not set – running without Supabase (only sheet/email).');
}

async function saveAttendeeToSupabase({
  name,
  email,
  phone,
  ticketId,
  eventId,
  eventName,
  ticketCategory,
  ticketNumber,
  bookingId,
}) {
  if (!supabase) return;
  const row = {
    name,
    email,
    phone: phone || null,
    ticket_id: ticketId,
    ticket_category: ticketCategory || null,
    ticket_number: ticketNumber || null,
    event_id: eventId || null,
    event_name: eventName || null,
  };
  if (bookingId) row.booking_id = bookingId;
  const { error } = await supabase.from('attendees').insert(row);
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
    const ev = await resolveEventRowByIdOrSlug(String(eventId));
    if (ev) {
      const parts = [`event_id.eq.${ev.id}`];
      if (ev.slug) parts.push(`event_id.eq.${ev.slug}`);
      query = query.or(parts.join(','));
    } else {
      query = query.eq('event_id', eventId);
    }
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

// Admin event saves embed base64 data URLs (card + detail + gallery); raise limit so saves do not 413.
app.use(
  compression({
    threshold: 1024,
  })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

function signSessionToken(user) {
  const payload = { sub: user.id, email: user.email };
  return jwt.sign(payload, JWT_SECRET || 'dev-insecure-secret', { expiresIn: '30d' });
}

function signScannerSessionToken({ scannerId, deviceId, operatorName }) {
  const opn = String(operatorName || '')
    .trim()
    .slice(0, 120);
  const payload = { sub: scannerId, did: deviceId, opn };
  return jwt.sign(payload, SCANNER_JWT_SECRET || 'dev-insecure-secret', { expiresIn: '8h' });
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

function setScannerCookie(res, token) {
  res.cookie('scanner_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearScannerCookie(res) {
  res.clearCookie('scanner_session', { path: '/' });
}

async function getScannerFromRequest(req) {
  const token = req.cookies?.scanner_session;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, SCANNER_JWT_SECRET || 'dev-insecure-secret');
    const scannerId = decoded?.sub;
    const deviceId = decoded?.did;
    const operatorName =
      typeof decoded?.opn === 'string' ? decoded.opn.trim().slice(0, 120) : '';
    // Require staff name in token (older cookies without opn must sign in again).
    if (!operatorName) return null;
    if (!scannerId || !deviceId || !supabase) return null;
    const { data: scanner, error } = await supabase
      .from('scanners')
      .select('id, name, active')
      .eq('id', scannerId)
      .maybeSingle();
    if (error || !scanner || !scanner.active) return null;
    return { scannerId, deviceId, scanner, operatorName };
  } catch {
    return null;
  }
}

async function requireScannerSession(req, res) {
  if (!supabase) {
    res.status(503).json({ error: 'Supabase not configured.' });
    return null;
  }
  const session = await getScannerFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Unauthorized.' });
    return null;
  }
  return session;
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

const AVATAR_MAX_BYTES = 2 * 1024 * 1024 + 1; // +1 avoids multer edge case at exact limit
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES },
});

/** Save avatar bytes; Supabase Storage bucket (public) if configured, else local public/uploads/avatars. */
async function persistAvatarAndUrl(userId, buffer, mimetype) {
  const extMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/pjpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  const mime = String(mimetype || '').toLowerCase();
  const ext = extMap[mime] || 'jpg';
  const objectPath = `${userId}/avatar.${ext}`;

  if (supabase) {
    const bucket = String(process.env.SUPABASE_AVATARS_BUCKET || 'avatars').trim() || 'avatars';
    const { error: upErr } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
      contentType: mime || mimetype || 'image/jpeg',
      upsert: true,
    });
    if (!upErr) {
      const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
      if (data?.publicUrl) return data.publicUrl;
    } else {
      console.warn('Avatar Storage upload failed (local fallback):', upErr.message);
    }
  }

  const dir = path.join(__dirname, 'public', 'uploads', 'avatars');
  const localName = `${userId}.${ext}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, localName), buffer);
  } catch (diskErr) {
    console.error('Avatar local save failed:', diskErr.message);
    throw new Error('Could not write file on server (check disk permissions or folder sync).');
  }
  const base = BASE_URL.replace(/\/$/, '');
  return `${base}/uploads/avatars/${localName}`;
}

/** Require login for checkout/account flows. Public catalog (events, event pages) stays browsable without a session. */
async function redirectIfNotLoggedIn(req, res) {
  if (!supabase) return false;
  const user = await getAuthUserFromRequest(req);
  if (user) return false;
  const next = encodeURIComponent(req.originalUrl || '/');
  res.redirect(302, `/auth?next=${next}`);
  return true;
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
  redirectIfNotLoggedIn(req, res)
    .then((redirected) => {
      if (redirected) return;
      res.sendFile(path.join(__dirname, 'public', 'profile.html'));
    })
    .catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send('Could not load page.');
    });
});
app.get('/cart', (req, res) => {
  redirectIfNotLoggedIn(req, res)
    .then((redirected) => {
      if (redirected) return;
      res.sendFile(path.join(__dirname, 'public', 'cart.html'));
    })
    .catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send('Could not load page.');
    });
});
app.get('/checkout', (req, res) => {
  redirectIfNotLoggedIn(req, res)
    .then((redirected) => {
      if (redirected) return;
      res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
    })
    .catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send('Could not load page.');
    });
});
app.get('/payment', (req, res) => {
  redirectIfNotLoggedIn(req, res)
    .then((redirected) => {
      if (redirected) return;
      res.sendFile(path.join(__dirname, 'public', 'payment.html'));
    })
    .catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send('Could not load page.');
    });
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
app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'faq.html'));
});
app.get('/who-we-are', (req, res) => res.redirect(301, '/about-us'));
app.get('/what-we-do', (req, res) => res.redirect(301, '/about-us'));
app.get('/my-tickets', (req, res) => {
  redirectIfNotLoggedIn(req, res)
    .then((redirected) => {
      if (redirected) return;
      res.sendFile(path.join(__dirname, 'public', 'my-tickets.html'));
    })
    .catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send('Could not load page.');
    });
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

app.get('/scan/:scannerId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

// Static files are registered after all API routes (see bottom of file) so POST /api/*
// and other API calls are never shadowed and behave the same locally and on Vercel.

const EVENTS_FILE_PATH = path.join(__dirname, 'public', 'events.json');
let eventsJsonCache = { mtimeMs: null, data: null };
let eventThumbCache = new Map(); // id -> { value: string, expiresAt: number }
let publicEventsCache = new Map(); // key(lite/full) -> { value, expiresAt }
let eventByIdCache = new Map(); // id/slug -> { value, expiresAt }
const PUBLIC_EVENTS_TTL_MS = 20000;
const EVENT_BY_ID_TTL_MS = 15000;

function getTtlCache(map, key) {
  const k = String(key || '');
  if (!k) return null;
  const hit = map.get(k);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(k);
    return null;
  }
  return hit.value;
}

function setTtlCache(map, key, value, ttlMs) {
  const k = String(key || '');
  if (!k) return;
  map.set(k, {
    value,
    expiresAt: Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : 10000),
  });
}

function getCachedThumb(id) {
  const key = String(id || '');
  const hit = eventThumbCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    eventThumbCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCachedThumb(id, value, ttlMs) {
  const key = String(id || '');
  if (!key) return;
  eventThumbCache.set(key, {
    value: value || '/block-logo.png',
    expiresAt: Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : 120000),
  });
}

function invalidateEventsJsonCache() {
  eventsJsonCache = { mtimeMs: null, data: null };
  eventThumbCache.clear();
  publicEventsCache.clear();
  eventByIdCache.clear();
}

// Events from local JSON (fallback if Supabase/events table not used)
function getEventsFromFile() {
  try {
    const st = fs.statSync(EVENTS_FILE_PATH);
    if (eventsJsonCache.data != null && eventsJsonCache.mtimeMs === st.mtimeMs) {
      return eventsJsonCache.data;
    }
    const raw = fs.readFileSync(EVENTS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    eventsJsonCache = { mtimeMs: st.mtimeMs, data: parsed };
    return parsed;
  } catch (e) {
    return [];
  }
}

function setEventsToFile(events) {
  try {
    fs.writeFileSync(EVENTS_FILE_PATH, JSON.stringify(events || [], null, 2), 'utf8');
    invalidateEventsJsonCache();
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

/** Supabase-backed event rules (Vercel-safe). Stored in public.app_settings.event_rules jsonb */
async function fetchEventRulesFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('event_rules')
      .eq('id', 'global')
      .maybeSingle();
    if (error) {
      const msg = String(error.message || '');
      if (/column .*event_rules|does not exist|42P01|Could not find the table/i.test(msg)) {
        console.warn('app_settings.event_rules missing — run latest supabase-production-deltas.sql');
        return null;
      }
      console.error('app_settings rules read:', error.message);
      return null;
    }
    if (!data || !data.event_rules || typeof data.event_rules !== 'object') return {};
    return data.event_rules;
  } catch (e) {
    console.error('app_settings rules read exception:', e.message);
    return null;
  }
}

async function upsertEventRulesToSupabase(rulesMap) {
  if (!supabase) throw new Error('Supabase not configured.');
  const payload = rulesMap && typeof rulesMap === 'object' ? rulesMap : {};
  const { error } = await supabase.from('app_settings').upsert(
    {
      id: 'global',
      event_rules: payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(error.message || 'Could not save rules.');
}

/** Same source order as admin routes: Supabase app_settings.event_rules, else event-rules.json */
async function getEventRulesMapResolved() {
  let rulesMap = null;
  if (supabase) {
    rulesMap = await fetchEventRulesFromSupabase();
  }
  if (!rulesMap || typeof rulesMap !== 'object') {
    rulesMap = getEventRulesFromFile();
  }
  return rulesMap;
}

function getDefaultEventRules() {
  return {
    startTime: '7:00 PM',
    doorsOpenTime: '4:00 PM',
    doorsCloseTime: '7:00 PM',
    minAge: 12,
    accompaniedByAdultUnderAge: 15,
    termsText:
      "By purchasing tickets you agree to BLOCK's terms of sale for this event, including any refund or exchange policy shown at checkout. Follow venue rules and staff instructions.",
    maxTicketsPerOrder: 10,
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
    maxTicketsPerOrder: Number.isFinite(Number(input.maxTicketsPerOrder))
      ? Math.min(100, Math.max(1, Number(input.maxTicketsPerOrder)))
      : d.maxTicketsPerOrder,
  };
}

function rawExtraToObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return {};
}

/** Merge image_* / image from JSON `extra` when top-level columns are empty (legacy rows, imports). */
function eventRowWithExtraImages(row) {
  if (!row || typeof row !== 'object') return row;
  const ex = rawExtraToObject(row.extra);
  function pick(key) {
    const a = row[key];
    const b = ex[key];
    const sa = a != null && String(a).trim() ? String(a).trim() : '';
    const sb = b != null && String(b).trim() ? String(b).trim() : '';
    if (sa) return sa;
    if (sb) return sb;
    return a != null ? a : b != null ? b : null;
  }
  return {
    ...row,
    image: pick('image'),
    image_card: pick('image_card'),
    image_detail: pick('image_detail'),
  };
}

function parseEventExtra(raw) {
  const rawObj = rawExtraToObject(raw);
  if (!rawObj || typeof rawObj !== 'object') return {};
  const out = {};
  if (Array.isArray(rawObj.tickets)) {
    out.tickets = rawObj.tickets.map((t, i) => ({
      ticketId: String((t && (t.ticketId || t.id)) || `t${i + 1}`),
      ticketName: String((t && (t.ticketName || t.name)) || `Category ${i + 1}`),
      ticketCategory: t && t.ticketCategory != null ? String(t.ticketCategory) : null,
      price: Number(t && t.price) || 0,
      available:
        t && t.available != null && t.available !== ''
          ? Math.max(0, parseInt(t.available, 10))
          : t && t.available_tickets != null && t.available_tickets !== ''
          ? Math.max(0, parseInt(t.available_tickets, 10))
          : null,
      soldOut: Boolean(t && t.soldOut),
    }));
  }
  if (Array.isArray(rawObj.gallery)) {
    out.gallery = rawObj.gallery.map((u) => String(u || '').trim()).filter(Boolean);
  }
  if (rawObj.location && typeof rawObj.location === 'object') {
    const le = rawObj.location;
    const vmu = le.venueMapUrl != null ? String(le.venueMapUrl).trim() : '';
    out.location = {
      address: le.address != null ? String(le.address) : '',
      mapEmbedUrl: le.mapEmbedUrl ? String(le.mapEmbedUrl).trim() : null,
      venueMapUrl: vmu || null,
    };
  }
  if (Array.isArray(rawObj.facilities)) {
    out.facilities = rawObj.facilities.map((f) => String(f || '').trim()).filter(Boolean);
  }
  if (rawObj.published === false || rawObj.published === 'false' || rawObj.published === 0 || rawObj.published === '0') {
    out.published = false;
  }
  return out;
}

function buildExtraFromAdminBody(body) {
  const b = body || {};
  const ex = {};
  if (Array.isArray(b.tickets)) {
    ex.tickets = b.tickets.map((t, i) => ({
      ticketId: String((t && (t.ticketId || t.id)) || `t${i + 1}`),
      ticketName: String((t && (t.ticketName || t.name)) || `Category ${i + 1}`),
      ticketCategory: t && t.ticketCategory != null ? String(t.ticketCategory) : null,
      price: Number(t && t.price) || 0,
      available:
        t && t.available != null && t.available !== ''
          ? Math.max(0, parseInt(t.available, 10))
          : null,
      soldOut: Boolean(t && t.soldOut),
    }));
  }
  if (Array.isArray(b.gallery)) {
    ex.gallery = b.gallery.map((u) => String(u || '').trim()).filter(Boolean);
  }
  if (b.location && typeof b.location === 'object') {
    const L = b.location;
    const vmu = L.venueMapUrl != null ? String(L.venueMapUrl).trim() : '';
    ex.location = {
      address: L.address != null ? String(L.address) : '',
      mapEmbedUrl: L.mapEmbedUrl ? String(L.mapEmbedUrl).trim() : null,
      venueMapUrl: vmu || null,
    };
  }
  if (Array.isArray(b.facilities)) {
    ex.facilities = b.facilities.map((f) => String(f || '').trim()).filter(Boolean);
  }
  const pub = b && b.published;
  ex.published = !(pub === false || pub === 'false' || pub === 0 || pub === '0');
  return ex;
}

function mergePublicEventExtras(base, extraRaw, legacyFileEvent) {
  const ex = parseEventExtra(extraRaw);
  const leg = legacyFileEvent || {};
  const merged = { ...base, ...ex };
  if (!merged.tickets && Array.isArray(leg.tickets)) merged.tickets = leg.tickets;
  if (!merged.gallery && Array.isArray(leg.gallery)) merged.gallery = leg.gallery;
  if (!merged.location && leg.location && typeof leg.location === 'object') merged.location = leg.location;
  if (!merged.facilities && Array.isArray(leg.facilities)) merged.facilities = leg.facilities;
  if (merged.published !== false && leg && leg.published === false) merged.published = false;
  return merged;
}

function normalizeAdminEventFromFile(event, sortOrderIndex) {
  const price = event && event.price != null && event.price !== '' ? Number(event.price) : 0;
  const availableTickets = event && event.available_tickets != null ? Number(event.available_tickets) : null;
  const base = {
    id: event.id,
    slug: event.slug || null,
    name: event.name || '',
    date: event.date || null,
    time: event.time || null,
    venue: event.venue || null,
    category: event.category || null,
    image: event.image || null,
    image_card: event.image_card || null,
    image_detail: event.image_detail || null,
    description: event.description || null,
    price: Number.isFinite(price) ? price : 0,
    available_tickets: availableTickets != null && Number.isFinite(availableTickets) ? availableTickets : null,
    sort_order: sortOrderIndex != null ? sortOrderIndex : null,
  };
  return mergePublicEventExtras(base, event.extra, event);
}

function loadAdminEventsFromFile() {
  const events = getEventsFromFile() || [];
  return events.map((e, idx) => normalizeAdminEventFromFile(e, idx + 1));
}

function mapSupabaseEventRowToAdmin(row) {
  if (!row) return null;
  const { extra: _ex, ...rest } = row;
  const flat = parseEventExtra(row.extra);
  return { ...rest, ...flat };
}

/** Public API + file rows: list/cards use imageCard, detail hero uses imageHero; `image` is a unified primary URL. */
function eventImageFields(row) {
  const r = row || {};
  const legacyRaw = r.image != null && String(r.image).trim() ? String(r.image).trim() : '';
  const icRaw = r.image_card != null && String(r.image_card).trim() ? String(r.image_card).trim() : '';
  const idRaw = r.image_detail != null && String(r.image_detail).trim() ? String(r.image_detail).trim() : '';
  const logo = '/block-logo.png';
  const unified = idRaw || icRaw || legacyRaw || logo;
  return {
    image: unified,
    imageCard: icRaw || legacyRaw || idRaw || logo,
    imageHero: idRaw || icRaw || legacyRaw || logo,
  };
}

function deriveEventImagesFromAdminBody(body) {
  const b = body || {};
  const rawCard = b.image_card != null ? String(b.image_card).trim() : '';
  const rawDetail = b.image_detail != null ? String(b.image_detail).trim() : '';
  const rawLegacy = b.image != null ? String(b.image).trim() : '';
  let image_card = rawCard || null;
  let image_detail = rawDetail || null;
  const image_legacy = rawLegacy || null;
  if (!image_card && image_legacy) image_card = image_legacy;
  if (!image_detail && image_legacy) image_detail = image_legacy;
  const image = image_detail || image_card || image_legacy || null;
  return { image, image_card, image_detail };
}

function isDataImageUrl(value) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(String(value || '').trim());
}

async function optimizeImageDataUrl(dataUrl, options = {}) {
  const raw = String(dataUrl || '').trim();
  if (!isDataImageUrl(raw)) return raw || null;
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (!m) return raw;
  const mime = String(m[1] || '').toLowerCase();
  // Keep vector and animated-safe formats untouched.
  if (mime === 'image/svg+xml' || mime === 'image/gif') return raw;
  try {
    const input = Buffer.from(m[2], 'base64');
    if (!input || !input.length) return raw;
    const maxWidth = Math.max(480, Number(options.maxWidth) || 1600);
    const quality = Math.max(55, Math.min(88, Number(options.quality) || 78));
    const transformed = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({
        width: maxWidth,
        withoutEnlargement: true,
        fit: 'inside',
      })
      .webp({ quality, effort: 4 })
      .toBuffer();
    if (!transformed || !transformed.length) return raw;
    // Keep original if optimization does not help payload size.
    if (transformed.length >= input.length) return raw;
    return `data:image/webp;base64,${transformed.toString('base64')}`;
  } catch (e) {
    return raw;
  }
}

async function deriveEventImagesFromAdminBodyAsync(body) {
  const normalized = deriveEventImagesFromAdminBody(body);
  const [card, detail, legacy] = await Promise.all([
    optimizeImageDataUrl(normalized.image_card, { maxWidth: 1200, quality: 76 }),
    optimizeImageDataUrl(normalized.image_detail, { maxWidth: 1800, quality: 80 }),
    optimizeImageDataUrl(normalized.image, { maxWidth: 1600, quality: 78 }),
  ]);
  const image_card = card || normalized.image_card || null;
  const image_detail = detail || normalized.image_detail || null;
  const image = detail || legacy || image_detail || image_card || null;
  return { image, image_card, image_detail };
}

// Map Supabase events rows into the public event shape
function mapEventRowToPublic(row) {
  if (!row) return null;
  const id = row.slug || row.id;
  const price = row.price != null && row.price !== '' ? Number(row.price) : 0;
  const imgs = eventImageFields(eventRowWithExtraImages(row));
  const base = {
    id,
    name: row.name,
    date: row.date,
    time: row.time,
    venue: row.venue,
    category: row.category,
    image: imgs.image,
    imageCard: imgs.imageCard,
    imageHero: imgs.imageHero,
    description: row.description,
    price,
    type: price > 0 ? 'paid' : 'free',
  };
  return mergePublicEventExtras(base, row.extra, null);
}

function mapFileEventToPublic(e) {
  if (!e) return null;
  const id = e.slug || e.id;
  const price = e.price != null && e.price !== '' ? Number(e.price) : 0;
  const imgs = eventImageFields(eventRowWithExtraImages(e));
  const base = {
    id,
    name: e.name,
    date: e.date,
    time: e.time,
    venue: e.venue,
    category: e.category,
    image: imgs.image,
    imageCard: imgs.imageCard,
    imageHero: imgs.imageHero,
    description: e.description,
    price,
    type: price > 0 ? 'paid' : 'free',
  };
  return mergePublicEventExtras(base, e.extra, e);
}

/** List/card API: no image BLOB columns — keeps JSON tiny; use /api/event-thumbs to hydrate artwork. */
function mapEventRowToPublicLite(row) {
  if (!row) return null;
  const id = row.slug || row.id;
  const price = row.price != null && row.price !== '' ? Number(row.price) : 0;
  const logo = '/block-logo.png';
  const base = {
    id,
    name: row.name,
    date: row.date,
    time: row.time,
    venue: row.venue,
    category: row.category,
    image: logo,
    imageCard: logo,
    imageHero: logo,
    description: row.description,
    price,
    type: price > 0 ? 'paid' : 'free',
  };
  return mergePublicEventExtras(base, row.extra, null);
}

function mapFileEventToPublicLite(e) {
  if (!e) return null;
  const id = e.slug || e.id;
  const price = e.price != null && e.price !== '' ? Number(e.price) : 0;
  const logo = '/block-logo.png';
  const base = {
    id,
    name: e.name,
    date: e.date,
    time: e.time,
    venue: e.venue,
    category: e.category,
    image: logo,
    imageCard: logo,
    imageHero: logo,
    description: e.description,
    price,
    type: price > 0 ? 'paid' : 'free',
  };
  return mergePublicEventExtras(base, e.extra, e);
}

function primaryImageFromRawRow(row) {
  if (!row) return '/block-logo.png';
  const imgs = eventImageFields(eventRowWithExtraImages(row));
  return imgs.imageHero || imgs.imageCard || imgs.image || '/block-logo.png';
}

function isProbablyUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ''));
}

async function getRawEventRowForImages(id) {
  const idStr = String(id || '').trim();
  if (!idStr) return null;
  if (supabase) {
    try {
      const sel = 'id, slug, image, image_card, image_detail, extra';
      const { data, error } = await supabase
        .from('events')
        .select(sel)
        .or(`id.eq.${idStr},slug.eq.${idStr}`)
        .limit(1)
        .maybeSingle();
      if (!error && data) return data;
      const slugVariants = [idStr, idStr.replace(/_/g, '-'), idStr.replace(/-/g, '_')];
      for (const v of slugVariants) {
        const { data: data2, error: error2 } = await supabase
          .from('events')
          .select(sel)
          .ilike('slug', v)
          .limit(1)
          .maybeSingle();
        if (!error2 && data2) return data2;
      }
    } catch (e) {
      console.error('getRawEventRowForImages:', e.message);
    }
  }
  const fileList = getEventsFromFile() || [];
  return fileList.find((e) => e && (e.id === idStr || e.slug === idStr)) || null;
}

// Prefer Supabase events table; fall back to JSON file
async function listEventsForPublic(opts = {}) {
  const lite = opts.lite === true;
  const cacheKey = lite ? 'lite' : 'full';
  const cached = getTtlCache(publicEventsCache, cacheKey);
  if (cached) return cached;
  if (supabase) {
    try {
      const columns = lite
        ? 'id, slug, name, date, time, venue, category, description, price, sort_order, created_at, extra'
        : 'id, slug, name, date, time, venue, category, image, image_card, image_detail, description, price, sort_order, created_at, extra';
      const { data, error } = await supabase
        .from('events')
        .select(columns)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });
      if (!error && data && data.length) {
        const mapper = lite ? mapEventRowToPublicLite : mapEventRowToPublic;
        const out = data
          .filter((row) => parseEventExtra(row.extra).published !== false)
          .map(mapper);
        setTtlCache(publicEventsCache, cacheKey, out, PUBLIC_EVENTS_TTL_MS);
        return out;
      }
      if (error) {
        console.error('Supabase events error:', error.message);
      }
    } catch (e) {
      console.error('Supabase events exception:', e.message);
    }
  }
  const fileList = getEventsFromFile() || [];
  const mapper = lite ? mapFileEventToPublicLite : mapFileEventToPublic;
  const out = fileList.map(mapper).filter((ev) => ev && ev.published !== false);
  setTtlCache(publicEventsCache, cacheKey, out, PUBLIC_EVENTS_TTL_MS);
  return out;
}

async function getEventById(id) {
  if (!id) return null;
  const lookupKey = String(id).trim();
  const cached = getTtlCache(eventByIdCache, lookupKey);
  if (cached) return cached;
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('events')
        .select('id, slug, name, date, time, venue, category, image, image_card, image_detail, description, price, extra')
        .or(`id.eq.${id},slug.eq.${id}`)
        .limit(1)
        .maybeSingle();
      if (!error && data) {
        const out = mapEventRowToPublic(data);
        setTtlCache(eventByIdCache, lookupKey, out, EVENT_BY_ID_TTL_MS);
        if (out && out.id) setTtlCache(eventByIdCache, String(out.id), out, EVENT_BY_ID_TTL_MS);
        if (out && out.slug) setTtlCache(eventByIdCache, String(out.slug), out, EVENT_BY_ID_TTL_MS);
        return out;
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
          .select('id, slug, name, date, time, venue, category, image, image_card, image_detail, description, price, extra')
          .ilike('slug', v)
          .limit(1)
          .maybeSingle();
        if (!error2 && data2) {
          const out2 = mapEventRowToPublic(data2);
          setTtlCache(eventByIdCache, lookupKey, out2, EVENT_BY_ID_TTL_MS);
          if (out2 && out2.id) setTtlCache(eventByIdCache, String(out2.id), out2, EVENT_BY_ID_TTL_MS);
          if (out2 && out2.slug) setTtlCache(eventByIdCache, String(out2.slug), out2, EVENT_BY_ID_TTL_MS);
          return out2;
        }
      }
    } catch (e) {
      console.error('Supabase getEventById exception:', e.message);
    }
  }
  const fileList = getEventsFromFile() || [];
  const fileHit = fileList.find((e) => e && (e.id === id || e.slug === id));
  const out = mapFileEventToPublic(fileHit) || null;
  if (out) {
    setTtlCache(eventByIdCache, lookupKey, out, EVENT_BY_ID_TTL_MS);
    if (out.id) setTtlCache(eventByIdCache, String(out.id), out, EVENT_BY_ID_TTL_MS);
    if (out.slug) setTtlCache(eventByIdCache, String(out.slug), out, EVENT_BY_ID_TTL_MS);
  }
  return out;
}

// Resolve event to its canonical UUID row (used for cart/bookings FK columns)
async function resolveEventRowByIdOrSlug(idOrSlug) {
  const id = String(idOrSlug || '').trim();
  if (!id || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('events')
      .select('id, slug, name, date, time, venue, category, image, image_card, image_detail, description, price, extra')
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
        .select('id, slug, name, date, time, venue, category, image, image_card, image_detail, description, price, extra')
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
  const hostRaw = String((req.hostname || req.headers?.host || '').split(':')[0] || '').toLowerCase();
  if (hostRaw === 'localhost' || hostRaw === '127.0.0.1' || hostRaw === '[::1]') return true;
  const candidate = String(
    (req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'])) ||
      req.ip ||
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      ''
  );
  // x-forwarded-for might be a list: take the last hop
  const ip = candidate.split(',').map((s) => s.trim()).filter(Boolean).slice(-1)[0] || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1')
  );
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

async function sendPasswordResetEmail({ toEmail, resetUrl }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, skipped: true };
  }
  const safe = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const safeUrl = safe(resetUrl);
  const html = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f5f5f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:28px 24px;box-shadow:0 4px 18px rgba(15,23,42,0.12);">
          <tr><td>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">Hi,</p>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#374151;">We received a request to reset the password for your BLOCK account. Use the button below to choose a new password.</p>
            <p style="margin:0 0 20px;">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 22px;background:#599151;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Reset password</a>
            </p>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;">If the button does not work, copy and paste this link into your browser:</p>
            <p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:#4b5563;word-break:break-all;">${safeUrl}</p>
            <p style="margin:0;font-size:13px;line-height:1.5;color:#9ca3af;">If you did not ask for this, you can ignore this email. Your password will stay the same.</p>
            <p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#111827;font-weight:600;">— BLOCK</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: String(toEmail || '').trim(),
    subject: 'Reset your BLOCK password',
    html,
  });
  return { ok: true, skipped: false };
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

async function insertAttendeeForBooking({ name, email, eventId, eventName, ticketId, ticketCategory, ticketNumber, bookingId }) {
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
    bookingId,
  });
}

function bookingTicketSlotCount(booking) {
  if (!booking) return 0;
  const sel = booking.ticket_selections;
  if (!Array.isArray(sel) || sel.length === 0) return 1;
  const n = sel.reduce((sum, s) => sum + Math.max(0, Number(s.quantity || 0)), 0);
  return n > 0 ? n : 1;
}

function paymentMethodLabel(m) {
  const x = String(m || '').toLowerCase();
  if (x === 'instapay') return 'InstaPay';
  if (x === 'visa' || x === 'card') return 'Card';
  if (x === 'applepay') return 'Apple Pay';
  if (x === 'fawry') return 'Fawry';
  if (x === 'free') return 'Free';
  return m ? String(m) : '—';
}

function paymentStatusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'paid' || s === 'confirmed') return 'Paid';
  if (s === 'pending_payment') return 'Pending payment';
  if (s === 'cancelled') return 'Cancelled';
  if (s === 'refunded') return 'Refunded';
  return status ? String(status) : '—';
}

/** Attach booking/payment fields for admin table; uses booking_id when set, else matches by email+event order. */
async function enrichAttendeeRowsForAdmin(rawRows) {
  if (!supabase || !Array.isArray(rawRows) || rawRows.length === 0) return rawRows || [];
  const rows = rawRows.map((r) => ({ ...r }));
  const bookingById = new Map();

  const explicitIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean).map((id) => String(id)))];
  if (explicitIds.length) {
    const { data: bs } = await supabase
      .from('bookings')
      .select('id, status, payment_method, price_paid, created_at, user_id, event_id, ticket_selections')
      .in('id', explicitIds);
    for (const b of bs || []) bookingById.set(String(b.id), b);
  }

  const needsHeuristic = rows.filter((r) => !r.booking_id);
  if (needsHeuristic.length) {
    const uniqueRawEids = [
      ...new Set(needsHeuristic.map((r) => String(r.event_id || '').trim()).filter(Boolean)),
    ];
    const canonByRaw = new Map();
    for (const rid of uniqueRawEids) {
      const ev = await resolveEventRowByIdOrSlug(rid);
      canonByRaw.set(rid, ev ? String(ev.id) : rid);
    }

    const emails = [...new Set(needsHeuristic.map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean))];
    const emailToUserId = new Map();
    if (emails.length) {
      const { data: users } = await supabase.from('app_users').select('id, email');
      for (const u of users || []) {
        const low = String(u.email || '').trim().toLowerCase();
        if (low) emailToUserId.set(low, u.id);
      }
    }

    const attByPair = new Map();
    for (const r of needsHeuristic) {
      const em = String(r.email || '').trim().toLowerCase();
      const uid = emailToUserId.get(em);
      const rawEid = String(r.event_id || '').trim();
      const canonEid = rawEid ? canonByRaw.get(rawEid) || rawEid : '';
      if (!uid || !canonEid) continue;
      const k = `${String(uid)}|${String(canonEid)}`;
      if (!attByPair.has(k)) attByPair.set(k, []);
      attByPair.get(k).push(r);
    }
    for (const arr of attByPair.values()) arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const userIds = [...new Set([...attByPair.keys()].map((k) => k.split('|')[0]))];
    const eventIds = [...new Set([...attByPair.keys()].map((k) => k.split('|')[1]))];
    let candBookings = [];
    if (userIds.length && eventIds.length) {
      const { data: bs } = await supabase
        .from('bookings')
        .select('id, status, payment_method, price_paid, created_at, user_id, event_id, ticket_selections')
        .in('user_id', userIds)
        .in('event_id', eventIds);
      candBookings = bs || [];
    }
    const byPair = new Map();
    for (const b of candBookings) {
      const k = `${String(b.user_id)}|${String(b.event_id)}`;
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push(b);
    }
    for (const arr of byPair.values()) arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    for (const [k, attendees] of attByPair) {
      const bookings = byPair.get(k) || [];
      let bi = 0;
      let slotsLeft = 0;
      let curBooking = null;
      for (const att of attendees) {
        while (bi < bookings.length && slotsLeft === 0) {
          curBooking = bookings[bi++];
          slotsLeft = bookingTicketSlotCount(curBooking);
        }
        if (curBooking && slotsLeft > 0) {
          bookingById.set(String(curBooking.id), curBooking);
          att._resolved_booking_id = String(curBooking.id);
          slotsLeft--;
        }
      }
    }
  }

  return rows.map((r) => {
    const bidRaw = r.booking_id || r._resolved_booking_id;
    const bid = bidRaw != null && bidRaw !== '' ? String(bidRaw) : '';
    const b = bid ? bookingById.get(bid) : null;
    const slots = b ? bookingTicketSlotCount(b) : 0;
    const amt = b != null ? Number(b.price_paid || 0) : null;
    const perTicket = b && slots > 0 ? Math.round((amt / slots) * 100) / 100 : null;
    const out = { ...r };
    delete out._resolved_booking_id;
    return {
      ...out,
      payment_status: b ? paymentStatusLabel(b.status) : '—',
      payment_method: b ? paymentMethodLabel(b.payment_method) : '—',
      payment_amount_total: amt,
      payment_amount_ticket: perTicket,
      booking_time: b ? b.created_at : null,
    };
  });
}

async function queryAdminAttendeesRows(eventId, eventName) {
  let query = supabase.from('attendees').select('*').order('created_at', { ascending: false });
  if (eventId) {
    const ev = await resolveEventRowByIdOrSlug(eventId);
    if (ev) {
      const parts = [`event_id.eq.${ev.id}`];
      if (ev.slug) parts.push(`event_id.eq.${ev.slug}`);
      query = query.or(parts.join(','));
    } else {
      query = query.eq('event_id', eventId);
    }
  } else if (eventName) {
    query = query.ilike('event_name', eventName);
  }
  return await query;
}

// ----- Routes -----

app.get('/api/events', async (req, res) => {
  const compact =
    String(req.query.compact || '').toLowerCase() === '1' ||
    String(req.query.compact || '').toLowerCase() === 'true';
  const events = await listEventsForPublic({ lite: compact });
  const list = Array.isArray(events) ? events : [];

  if (compact) {
    const slim = list.map((ev) => {
      const image = ev?.imageCard || ev?.imageHero || ev?.image || '/block-logo.png';
      const desc = String(ev?.description || '');
      return {
        id: ev?.id,
        name: ev?.name,
        date: ev?.date,
        time: ev?.time,
        venue: ev?.venue,
        category: ev?.category || null,
        price: Number(ev?.price || 0),
        type: ev?.type || (Number(ev?.price || 0) > 0 ? 'paid' : 'free'),
        image,
        description: desc.length > 400 ? `${desc.slice(0, 400)}…` : desc,
      };
    });
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(slim);
  }

  res.set('Cache-Control', 'public, max-age=15');
  res.json(list);
});

app.get('/api/event-thumb/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id is required.' });
  const cached = getCachedThumb(id);
  if (cached) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ image: cached });
  }
  const row = await getRawEventRowForImages(id);
  if (!row) return res.status(404).json({ error: 'Event not found.' });
  const img = primaryImageFromRawRow(row);
  setCachedThumb(id, img, 5 * 60 * 1000);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ image: img });
});

app.get('/api/event-thumbs', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
  if (!ids.length) return res.json({});

  const out = {};
  const missing = [];
  ids.forEach((id) => {
    const cached = getCachedThumb(id);
    if (cached) out[id] = cached;
    else {
      out[id] = '/block-logo.png';
      missing.push(id);
    }
  });
  if (!missing.length) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(out);
  }

  if (supabase) {
    try {
      const uuids = [...new Set(missing.filter(isProbablyUuid))];
      const slugs = [...new Set(missing.filter((x) => !isProbablyUuid(x)))];
      const rowByKey = new Map();
      const ingest = (rows) => {
        (rows || []).forEach((r) => {
          if (r && r.id != null) rowByKey.set(String(r.id), r);
          if (r && r.slug) rowByKey.set(String(r.slug).toLowerCase(), r);
        });
      };
      const sel = 'id, slug, image, image_card, image_detail, extra';
      if (uuids.length) {
        const { data } = await supabase.from('events').select(sel).in('id', uuids);
        ingest(data);
      }
      if (slugs.length) {
        const { data } = await supabase.from('events').select(sel).in('slug', slugs);
        ingest(data);
      }
      for (const id of missing) {
        const row =
          rowByKey.get(String(id)) ||
          rowByKey.get(String(id).toLowerCase()) ||
          null;
        if (row) {
          const img = primaryImageFromRawRow(row);
          out[id] = img;
          setCachedThumb(id, img, 5 * 60 * 1000);
        }
      }
    } catch (e) {
      console.error('event-thumbs:', e.message);
    }
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(out);
  }

  const fileList = getEventsFromFile() || [];
  for (const id of missing) {
    const hit = fileList.find((e) => e && (e.id === id || e.slug === id));
    if (hit) {
      const img = primaryImageFromRawRow(hit);
      out[id] = img;
      setCachedThumb(id, img, 5 * 60 * 1000);
    }
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json(out);
});

app.get('/api/event-image/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).send('id is required');
  const row = await getRawEventRowForImages(id);
  if (!row) return res.status(404).send('Event not found');
  const img = String(primaryImageFromRawRow(row) || '').trim();
  if (!img) return res.status(404).send('No image');

  // Convert data URL to real image response so clients don't need to decode huge data URIs.
  const m = img.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (m) {
    const mime = m[1];
    const b64 = m[2];
    try {
      const buf = Buffer.from(b64, 'base64');
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Content-Type', mime);
      return res.send(buf);
    } catch (e) {
      // fall through to redirect fallback
    }
  }

  // If it's a normal URL/path, redirect to it.
  if (/^https?:\/\//i.test(img) || img.startsWith('/')) {
    return res.redirect(img);
  }
  res.status(404).send('Invalid image source');
});

// Booking event details for the TicketsMarche-style flow
// Returns: facilities, location, ticket categories, and rules (per event).
app.get('/api/booking-event/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const base = await getEventById(id);
  if (!base) return res.status(404).json({ error: 'Event not found.' });

  const rulesMap = await getEventRulesMapResolved();
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
  const location =
    base.location && typeof base.location === 'object'
      ? base.location
      : { address: base.venue || '', mapEmbedUrl: null, venueMapUrl: null };

  // Show live remaining seats in the booking popup:
  // remaining = configured category cap - already booked quantity.
  // We query by canonical id and requested id to cover id/slug storage differences.
  let bookedByKey = new Map();
  try {
    const primary = await getBookedCountsForEvent(base.id || id);
    bookedByKey = primary && primary.byKey instanceof Map ? primary.byKey : new Map();
    if (base.id && id && base.id !== id) {
      const secondary = await getBookedCountsForEvent(id);
      if (secondary && secondary.byKey instanceof Map) {
        secondary.byKey.forEach((qty, key) => {
          bookedByKey.set(key, (bookedByKey.get(key) || 0) + (Number(qty) || 0));
        });
      }
    }
  } catch (e) {
    console.warn('Could not load live booked counts for booking-event:', e && e.message ? e.message : e);
  }

  res.set('Cache-Control', 'public, max-age=10');
  res.json({
    ...base,
    facilities,
    location,
    tickets: tickets.map((t) => {
      const ticketId = t.ticketId || t.id;
      const ticketCategory = t.ticketCategory || t.category || null;
      const ticketName = t.ticketName || t.name;
      const key =
        normalizeTicketKey(ticketId) ||
        normalizeTicketKey(ticketCategory) ||
        normalizeTicketKey(ticketName);
      const rawCap =
        t.available != null && t.available !== ''
          ? Math.max(0, parseInt(t.available, 10))
          : t.available_tickets != null && t.available_tickets !== ''
          ? Math.max(0, parseInt(t.available_tickets, 10))
          : null;
      const used = key ? bookedByKey.get(key) || 0 : 0;
      const remaining = rawCap != null ? Math.max(0, rawCap - used) : null;
      return {
        id: ticketId,
        name: ticketName,
        category: ticketCategory,
        price: Number(t.price || 0),
        soldOut: Boolean(t.soldOut) || (remaining != null && remaining <= 0),
        available: remaining,
      };
    }),
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

  const rulesMap = await getEventRulesMapResolved();
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

  const rulesMap = await getEventRulesMapResolved();
  const rulesKey = base.id || id;
  const normalized = normalizeEventRules(req.body);
  rulesMap[rulesKey] = normalized;
  if (supabase) {
    try {
      await upsertEventRulesToSupabase(rulesMap);
    } catch (e) {
      return res.status(500).json({
        error:
          'Could not save rules in Supabase. Run the app_settings event_rules block in supabase-production-deltas.sql and redeploy.',
        details: e.message || 'Unknown error',
      });
    }
  } else {
    const ok = setEventRulesToFile(rulesMap);
    if (!ok) return res.status(500).json({ error: 'Could not save rules.' });
  }

  res.json({ success: true, rules: normalized });
});

// ----- Auth (email/password, session cookie w/ JWT) -----
app.get('/api/auth/me', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const user = await getAuthUserFromRequest(req);
  if (!user) return res.json({ user: null });

  const { data: bookings } = await supabase
    .from('bookings')
    .select(
      'id, created_at, payment_method, price_paid, status, event_id, instapay_sender_phone, events(name, date, time, venue, image, image_card, image_detail, description, price)'
    )
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

  res.json({
    user,
    bookedEvents: safeBookings.map((b) => {
      const event = b.events
        ? (() => {
            const im = eventImageFields(b.events);
            return {
              id: b.event_id,
              name: b.events.name,
              date: b.events.date,
              time: b.events.time,
              venue: b.events.venue,
              image: im.image,
              imageCard: im.imageCard,
              imageHero: im.imageHero,
              description: b.events.description,
              price: Number(b.events.price || 0),
              type: Number(b.events.price || 0) > 0 ? 'paid' : 'free',
            };
          })()
        : null;

      const paymentStatus =
        b.status === 'paid' || b.status === 'confirmed' ? 'Paid' : b.status === 'pending_payment' ? 'Pending' : String(b.status || 'Pending');

      const tickets =
        paymentStatus === 'Paid' ? attendeeTicketsByEventId.get(b.event_id) || [] : [];
      const ticketId = tickets.length ? tickets[0].ticketId : null;
      const ticketIds = tickets.map((t) => t.ticketId);
      const selectionCount = Array.isArray(b.ticket_selections)
        ? b.ticket_selections.reduce((sum, s) => sum + Math.max(0, Number(s && s.quantity ? s.quantity : 0) || 0), 0)
        : 0;
      const ticketsCount = Math.max(selectionCount, ticketIds.length);
      const instapayPendingRow = b.payment_method === 'instapay' && b.status === 'pending_payment';

      return {
        id: b.id,
        status: b.status,
        paymentMethod: b.payment_method,
        paymentStatus,
        instapayPaymentUrl: instapayPendingRow ? INSTAPAY_IPN_PAYMENT_URL : null,
        instapayQrImageUrl: instapayPendingRow ? INSTAPAY_QR_IMAGE_PATH : null,
        instapaySenderPhone: b.instapay_sender_phone || null,
        ticketId,
        ticketIds,
        ticketsCount,
        pricePaid: Number(b.price_paid || 0),
        createdAt: b.created_at,
        event,
      };
    }),
  });
});

app.post('/api/auth/signup', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const firstName = String(req.body?.firstName || '').trim();
  const lastName = String(req.body?.lastName || '').trim();
  const combinedName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const name = String(req.body?.name || '').trim() || combinedName || null;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const profilePictureUrl = String(req.body?.profilePictureUrl || '').trim() || null;
  const phoneIn = String(req.body?.phone || '').trim();
  let phone = null;
  if (phoneIn) {
    const compact = phoneIn.replace(/[^\d+]/g, '');
    const withPlus = compact.startsWith('+')
      ? compact
      : `+${compact.replace(/\D/g, '')}`;
    const digits = withPlus.slice(1).replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      return res.status(400).json({ error: 'Please enter a valid international phone number.' });
    }
    phone = `+${digits}`;
  }
  const birthdateRaw = String(req.body?.birthdate || '').trim();
  const birthdate =
    /^\d{4}-\d{2}-\d{2}$/.test(birthdateRaw) ? birthdateRaw : null;
  const gender = String(req.body?.gender || '').trim().slice(0, 32) || null;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const insertRow = {
    name,
    email,
    password_hash: passwordHash,
    profile_picture_url: profilePictureUrl,
    phone,
    birthdate,
    gender,
  };
  let { data, error } = await supabase
    .from('app_users')
    .insert(insertRow)
    .select('id, name, email, profile_picture_url, created_at')
    .single();

  if (
    error &&
    /phone|birthdate|gender|column|schema/i.test(String(error.message || error.details || ''))
  ) {
    ({ data, error } = await supabase
      .from('app_users')
      .insert({
        name,
        email,
        password_hash: passwordHash,
        profile_picture_url: profilePictureUrl,
      })
      .select('id, name, email, profile_picture_url, created_at')
      .single());
  }

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

const FORGOT_PASSWORD_OK =
  'If an account exists for that email, we sent a link to reset your password. Check your inbox and spam folder.';

app.post('/api/auth/forgot-password', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Password reset is not available (database not configured).' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email.' });
  }

  const generic = { ok: true, message: FORGOT_PASSWORD_OK };

  try {
    const { data: user, error: findErr } = await supabase
      .from('app_users')
      .select('id, email')
      .eq('email', email)
      .maybeSingle();

    if (findErr) {
      console.error('forgot-password lookup:', findErr.message);
      return res.json(generic);
    }

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const { error: updErr } = await supabase
        .from('app_users')
        .update({
          password_reset_token_hash: tokenHash,
          password_reset_expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id);

      if (updErr) {
        console.error('forgot-password token save:', updErr.message);
      } else {
        const resetUrl = `${BASE_URL}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
        const sent = await sendPasswordResetEmail({ toEmail: email, resetUrl });
        if (sent.skipped) {
          console.warn('Password reset email skipped (set EMAIL_USER / EMAIL_APP_PASSWORD). Dev link:', resetUrl);
        } else if (!sent.ok) {
          console.error('Password reset email failed to send.');
        }
      }
    }

    return res.json(generic);
  } catch (e) {
    console.error('forgot-password:', e.message);
    return res.json(generic);
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Password reset is not available.' });
  const rawToken = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');
  if (!rawToken || rawToken.length < 32) {
    return res.status(400).json({ error: 'Invalid or expired reset link. Request a new one from the sign-in page.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const { data: user, error: findErr } = await supabase
    .from('app_users')
    .select('id, password_reset_expires_at')
    .eq('password_reset_token_hash', tokenHash)
    .maybeSingle();

  if (findErr || !user) {
    return res.status(400).json({ error: 'Invalid or expired reset link. Request a new one from the sign-in page.' });
  }

  const exp = user.password_reset_expires_at ? new Date(user.password_reset_expires_at) : null;
  if (!exp || Number.isNaN(exp.getTime()) || exp < new Date()) {
    return res.status(400).json({ error: 'This reset link has expired. Request a new one from the sign-in page.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { error: upErr } = await supabase
    .from('app_users')
    .update({
      password_hash: passwordHash,
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (upErr) {
    console.error('reset-password update:', upErr.message);
    return res.status(500).json({ error: 'Could not update password. Try again.' });
  }

  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.patch('/api/auth/profile', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const name = String(req.body?.name ?? '').trim() || null;
  const { data, error } = await supabase
    .from('app_users')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select('id, name, email, profile_picture_url, created_at')
    .single();
  if (error) return res.status(500).json({ error: 'Could not update profile.' });
  res.json({ user: data });
});

app.post('/api/auth/profile/avatar', (req, res) => {
  avatarUpload.single('avatar')(req, res, (multerErr) => {
    void (async () => {
      try {
        if (multerErr) {
          const code = multerErr.code;
          if (code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Image must be 2MB or smaller.' });
          }
          if (multerErr instanceof multer.MulterError) {
            return res.status(400).json({ error: multerErr.message || 'Upload could not be read.' });
          }
          return res.status(400).json({ error: String(multerErr.message || multerErr) || 'Upload could not be read.' });
        }

        const user = await requireAuth(req, res);
        if (!user) return;
        if (!req.file?.buffer) {
          return res.status(400).json({ error: 'Choose an image file.' });
        }
        const mt = String(req.file.mimetype || '').toLowerCase();
        if (!/^image\/(jpeg|jpg|pjpeg|png|webp|gif|avif)$/.test(mt)) {
          return res.status(400).json({
            error:
              'Use JPEG, PNG, WebP, AVIF, or GIF. (iPhone HEIC is not supported — choose “Most Compatible” or convert to JPEG.)',
          });
        }

        const publicUrl = await persistAvatarAndUrl(user.id, req.file.buffer, mt);
        const { data, error } = await supabase
          .from('app_users')
          .update({ profile_picture_url: publicUrl, updated_at: new Date().toISOString() })
          .eq('id', user.id)
          .select('id, name, email, profile_picture_url, created_at')
          .single();
        if (error) {
          console.error('Avatar DB update:', error.message, error.details || '');
          return res.status(500).json({
            error: error.message ? `Could not save profile photo: ${error.message}` : 'Could not save profile photo.',
          });
        }
        res.json({ user: data });
      } catch (e) {
        console.error('Avatar upload:', e);
        if (!res.headersSent) {
          res.status(500).json({ error: e.message ? `Could not upload image: ${e.message}` : 'Could not upload image.' });
        }
      }
    })();
  });
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

  const next = String(req.query.next || '/');

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

  const next = req.cookies?.google_oauth_next || '/';

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
    .select('event_id, created_at, ticket_selections, events(id, name, date, time, venue, image, image_card, image_detail, description, price)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  // Backward-compat for old schema (before ticket_selections column)
  if (error && String(error.message || '').toLowerCase().includes('ticket_selections')) {
    ({ data, error } = await supabase
      .from('cart_items')
      .select('event_id, created_at, events(id, name, date, time, venue, image, image_card, image_detail, description, price)')
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
          ? (() => {
              const im = eventImageFields(row.events);
              return {
                id: row.events.id,
                name: row.events.name,
                date: row.events.date,
                time: row.events.time,
                venue: row.events.venue,
                image: im.image,
                imageCard: im.imageCard,
                imageHero: im.imageHero,
                description: row.events.description,
                price: unitEventPrice,
                type: unitEventPrice > 0 ? 'paid' : 'free',
              };
            })()
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

  // When the cart was just cleared, there might be no existing row.
  // In that case, treat it as empty selections and proceed with upsert.
  let existingSelections = [];
  if (fetchError) {
    const msg = String(fetchError.message || '').toLowerCase();
    const code = String(fetchError.code || '');
    const looksLikeNoRow =
      code === 'PGRST116' ||
      msg.includes('no rows') ||
      msg.includes('0 rows') ||
      msg.includes('results contain 0') ||
      msg.includes('no record');
    if (!looksLikeNoRow) {
      return res.status(500).json({
        error: 'Could not load cart selections.',
      });
    }
  }

  if (existing && Array.isArray(existing.ticket_selections)) existingSelections = existing.ticket_selections;
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
function bookingDuplicatePolicyMessage() {
  return (
    'This project allows multiple purchases per event, but your Supabase database still has an old rule ' +
    '(one booking per user per event). Open Supabase → SQL → run the block under ' +
    '"allow multiple bookings per user for the same event" in supabase-production-deltas.sql, then try again.'
  );
}

function isBookingsUniqueViolation(error) {
  if (!error) return false;
  if (String(error.code || '') === '23505') return true;
  const msg = String(error.message || '').toLowerCase();
  return (
    msg.includes('duplicate') ||
    msg.includes('unique constraint') ||
    msg.includes('idx_bookings') ||
    (msg.includes('bookings') && msg.includes('unique'))
  );
}

function normalizeTicketKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function quantityFromSelection(sel) {
  return Math.max(0, parseInt(sel && (sel.quantity ?? sel.qty ?? 0), 10) || 0);
}

function selectionKey(sel) {
  const byId = normalizeTicketKey(sel && (sel.ticketId ?? sel.id));
  if (byId && byId !== 'default') return byId;
  const byCategory = normalizeTicketKey(sel && (sel.ticketCategory ?? sel.category));
  if (byCategory) return byCategory;
  return normalizeTicketKey(sel && (sel.ticketName ?? sel.name));
}

function eventTicketCapacity(event) {
  const byKey = new Map();
  const tickets = Array.isArray(event && event.tickets) ? event.tickets : [];
  tickets.forEach((t, idx) => {
    const key =
      normalizeTicketKey(t && (t.ticketId ?? t.id)) ||
      normalizeTicketKey(t && (t.ticketCategory ?? t.category)) ||
      normalizeTicketKey(t && (t.ticketName ?? t.name)) ||
      `cat_${idx + 1}`;
    const capRaw = t && t.available != null ? t.available : t && t.available_tickets != null ? t.available_tickets : null;
    const capNum = capRaw != null && capRaw !== '' ? Math.max(0, parseInt(capRaw, 10) || 0) : null;
    byKey.set(key, {
      name: String((t && (t.ticketName || t.name || t.ticketCategory || t.category)) || 'Ticket'),
      cap: capNum,
      soldOut: Boolean(t && t.soldOut),
    });
  });
  const totalRaw = event && event.available_tickets != null ? event.available_tickets : null;
  const totalCap = totalRaw != null && totalRaw !== '' ? Math.max(0, parseInt(totalRaw, 10) || 0) : null;
  return { byKey, totalCap };
}

async function getBookedCountsForEvent(eventId) {
  const result = { total: 0, byKey: new Map() };
  if (!supabase || !eventId) return result;
  const canonicalEvent = await getEventById(eventId);
  const eventAliases = Array.from(
    new Set(
      [eventId, canonicalEvent && canonicalEvent.id, canonicalEvent && canonicalEvent.slug]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    )
  );

  // 1) Reservation counts from bookings (includes pending checkout reservations)
  const { data, error } = await supabase
    .from('bookings')
    .select('status, ticket_selections')
    .in('event_id', eventAliases)
    .in('status', ['paid', 'confirmed', 'pending_payment', 'pending', 'processing']);

  if (error) throw error;

  const fromBookings = { total: 0, byKey: new Map() };
  (data || []).forEach((b) => {
    const sels = Array.isArray(b && b.ticket_selections) ? b.ticket_selections : [];
    sels.forEach((s) => {
      const qty = quantityFromSelection(s);
      if (!qty) return;
      fromBookings.total += qty;
      const key = selectionKey(s);
      if (!key) return;
      fromBookings.byKey.set(key, (fromBookings.byKey.get(key) || 0) + qty);
    });
  });

  // 2) Issued-ticket counts from attendees (covers legacy rows where booking_selections may be missing)
  const fromAttendees = { total: 0, byKey: new Map() };
  const { data: attendeeRows, error: attendeeErr } = await supabase
    .from('attendees')
    .select('ticket_id, ticket_category')
    .in('event_id', eventAliases);
  if (attendeeErr) throw attendeeErr;
  (attendeeRows || []).forEach((r) => {
    const key =
      normalizeTicketKey(r && r.ticket_category) ||
      normalizeTicketKey(r && r.ticket_id);
    if (!key) return;
    fromAttendees.total += 1;
    fromAttendees.byKey.set(key, (fromAttendees.byKey.get(key) || 0) + 1);
  });

  // Merge without double-counting: take the higher count per bucket.
  // (Bookings and attendees can represent the same sale in different shapes.)
  const mergedKeys = new Set([
    ...Array.from(fromBookings.byKey.keys()),
    ...Array.from(fromAttendees.byKey.keys()),
  ]);
  mergedKeys.forEach((key) => {
    result.byKey.set(
      key,
      Math.max(fromBookings.byKey.get(key) || 0, fromAttendees.byKey.get(key) || 0)
    );
  });
  result.total = Math.max(fromBookings.total, fromAttendees.total);

  return result;
}

function aggregateRequestedSelections(item) {
  const out = { total: 0, byKey: new Map() };
  const sels = Array.isArray(item && item.ticketSelections) ? item.ticketSelections : [];
  sels.forEach((s) => {
    const qty = quantityFromSelection(s);
    if (!qty) return;
    out.total += qty;
    const key = selectionKey(s);
    if (!key) return;
    out.byKey.set(key, (out.byKey.get(key) || 0) + qty);
  });
  return out;
}

async function validateCartTicketCaps(cart) {
  const items = Array.isArray(cart && cart.items) ? cart.items : [];
  for (const item of items) {
    const eventId = item && item.eventId;
    if (!eventId) continue;
    const event = await getEventById(eventId);
    if (!event) return `Event not found for checkout (${eventId}).`;

    const capacity = eventTicketCapacity(event);
    const booked = await getBookedCountsForEvent(eventId);
    const requested = aggregateRequestedSelections(item);

    for (const [key, reqQty] of requested.byKey.entries()) {
      const cap = capacity.byKey.get(key);
      if (cap && cap.soldOut) {
        return `Ticket category "${cap.name}" is sold out for ${event.name}.`;
      }
      if (cap && cap.cap != null) {
        const used = booked.byKey.get(key) || 0;
        if (used + reqQty > cap.cap) {
          const remaining = Math.max(0, cap.cap - used);
          return `Not enough seats in "${cap.name}" for ${event.name}. Remaining: ${remaining}.`;
        }
      }
    }

    if (capacity.totalCap != null && booked.total + requested.total > capacity.totalCap) {
      const remainingTotal = Math.max(0, capacity.totalCap - booked.total);
      return `Not enough total seats for ${event.name}. Remaining: ${remainingTotal}.`;
    }
  }
  return null;
}

async function confirmBookingsFromCart(userId, paymentMethod, pricePaidByEventId) {
  const cart = await getCartForUser(userId);
  const capError = await validateCartTicketCaps(cart);
  if (capError) return { error: capError };
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
    if (isBookingsUniqueViolation(error)) {
      return { error: bookingDuplicatePolicyMessage() };
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
  const capError = await validateCartTicketCaps(cart);
  if (capError) return res.status(400).json({ error: capError });

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
  const capError = await validateCartTicketCaps(cart);
  if (capError) return res.status(400).json({ error: capError });

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
    if (error) {
      if (isBookingsUniqueViolation(error)) {
        return res.status(400).json({ error: bookingDuplicatePolicyMessage() });
      }
      return res.status(400).json({ error: 'Could not confirm booking.' });
    }

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
            bookingId: b.id,
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

  if (
    method !== 'instapay' &&
    method !== 'visa' &&
    method !== 'card' &&
    method !== 'applepay' &&
    method !== 'credit' &&
    method !== 'debit' &&
    method !== 'fawry'
  ) {
    return res.status(400).json({ error: 'Invalid payment method.' });
  }

  const promoCodeRaw = String(req.body?.promoCode || '').trim();
  let promo = null;
  if (promoCodeRaw) {
    promo = await resolveActivePromoCodeAsync(promoCodeRaw);
    if (!promo) return res.status(400).json({ error: 'Invalid or inactive promo code.' });
  }
  const pricing = pricePaidListForCartWithPromo(cart, promo);

  // Normalize method to the values used by the UI + admin
  const normalizedMethod =
    method === 'applepay' ? 'applepay' : method === 'instapay' ? 'instapay' : method === 'fawry' ? 'fawry' : 'card';
  const isInsta = normalizedMethod === 'instapay';

  const rows = cart.items.map((i, idx) => ({
    user_id: user.id,
    event_id: i.eventId,
    payment_method: normalizedMethod,
    price_paid: Number(pricing.pricePaid[idx] != null ? pricing.pricePaid[idx] : i.selectionsTotal || i.price || 0),
    ticket_selections: i.ticketSelections || [],
    status: isInsta ? 'pending_payment' : 'paid',
  }));

  const { data: inserted, error } = await supabase.from('bookings').insert(rows).select('id, event_id');
  if (error) {
    if (isBookingsUniqueViolation(error)) {
      return res.status(400).json({ error: bookingDuplicatePolicyMessage() });
    }
    return res.status(400).json({ error: 'Could not process checkout.' });
  }

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
          bookingId: b.id,
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

app.post('/api/checkout/preview-promo', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const cart = await getCartForUser(user.id);
  if (!cart.items.length) return res.status(400).json({ error: 'Cart is empty.' });

  const totalBefore = Number(cart.total || 0);
  const code = String(req.body?.promoCode || '').trim();
  let promo = null;
  if (code) {
    promo = await resolveActivePromoCodeAsync(code);
    if (!promo) return res.status(400).json({ error: 'Invalid or inactive promo code.' });
  }

  const lineCents = cart.items.map((i) => Math.round(Number(i.selectionsTotal || i.price || 0) * 100));
  const totalCents = lineCents.reduce((a, b) => a + b, 0);
  const discountCents = computePromoDiscountCents(totalCents, promo);
  const totalAfter = Math.max(0, totalCents - discountCents) / 100;

  res.json({
    totalBefore,
    discount: discountCents / 100,
    totalAfter,
    promoApplied: Boolean(promo),
    promoCode: promo ? promo.code : null,
  });
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

// Public: InstaPay deep link + static QR path (same for all customers)
app.get('/api/instapay-info', (req, res) => {
  res.json({ paymentUrl: INSTAPAY_IPN_PAYMENT_URL, qrImageUrl: INSTAPAY_QR_IMAGE_PATH });
});

// InstaPay payment details for a specific pending booking (ownership checked)
app.get('/api/bookings/instapay-qr/:bookingId', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const bookingId = String(req.params.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required.' });

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, user_id, status, payment_method, instapay_sender_phone')
    .eq('id', bookingId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.payment_method !== 'instapay' || booking.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Booking is not pending InstaPay.' });
  }

  const paymentRef = getPaymentRefForBooking(booking.id);
  res.json({
    bookingId: booking.id,
    paymentRef,
    paymentUrl: INSTAPAY_IPN_PAYMENT_URL,
    qrImageUrl: INSTAPAY_QR_IMAGE_PATH,
    instapaySenderPhone: booking.instapay_sender_phone || null,
  });
});

// User submits the phone number they paid from (pending InstaPay only; admin confirms later)
app.post('/api/bookings/instapay-sender-phone', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const bookingIdsRaw = req.body?.bookingIds;
  const bookingIds = Array.isArray(bookingIdsRaw)
    ? bookingIdsRaw.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const senderPhone = String(req.body?.senderPhone || '').trim();
  if (!bookingIds.length) return res.status(400).json({ error: 'bookingIds is required.' });
  if (!senderPhone) return res.status(400).json({ error: 'senderPhone is required.' });
  if (senderPhone.length > 40) return res.status(400).json({ error: 'Phone number is too long.' });

  const { data: rows, error: fetchErr } = await supabase
    .from('bookings')
    .select('id, user_id, status, payment_method')
    .in('id', bookingIds)
    .eq('user_id', user.id);

  if (fetchErr) return res.status(500).json({ error: 'Could not verify bookings.' });
  const okRows = (rows || []).filter(
    (r) => r && r.payment_method === 'instapay' && r.status === 'pending_payment'
  );
  if (!okRows.length) {
    return res.status(400).json({ error: 'No matching pending InstaPay bookings for your account.' });
  }

  const okIds = okRows.map((r) => r.id);
  const { error: updErr } = await supabase
    .from('bookings')
    .update({ instapay_sender_phone: senderPhone })
    .in('id', okIds)
    .eq('user_id', user.id);

  if (updErr) return res.status(500).json({ error: 'Could not save phone number.' });
  res.json({ ok: true, updated: okIds.length });
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
    .select(
      'id, user_id, event_id, status, payment_method, price_paid, ticket_selections, created_at, instapay_sender_phone'
    )
    .eq('payment_method', 'instapay');

  if (error) {
    console.error('InstaPay bookings list error:', error.message);
    return res.json([]);
  }

  const filtered = status ? (bookings || []).filter((b) => b.status === status) : bookings || [];
  const userIds = [...new Set(filtered.map((b) => b.user_id).filter(Boolean))];
  const eventIds = [...new Set(filtered.map((b) => b.event_id).filter(Boolean))];

  const { data: users } = userIds.length
    ? await supabase.from('app_users').select('id, name, email, profile_picture_url').in('id', userIds)
    : { data: [] };
  const { data: events } = eventIds.length
    ? await supabase
        .from('events')
        .select('id, name, date, time, venue, image, image_card, image_detail, description, price')
        .in('id', eventIds)
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
      instapaySenderPhone: b.instapay_sender_phone || null,
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
        bookingId,
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

app.get('/admin-scanners', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-scanners.html'));
});

/** Tab icon: many clients request /favicon.ico by default */
app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.redirect(302, '/block-logo.png');
});

// TicketsMarche-style routes
app.get('/event/checkout', (req, res) => {
  redirectIfNotLoggedIn(req, res)
    .then((redirected) => {
      if (redirected) return;
      res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
    })
    .catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).send('Could not load page.');
    });
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

/** Public site origin for sitemap, robots, and absolute URLs (prefer BASE_URL in production). */
function siteOriginFromRequest(req) {
  const trimmed = String(process.env.BASE_URL || '').replace(/\/$/, '');
  if (trimmed && /^https?:\/\//i.test(trimmed)) return trimmed;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const scheme = proto === 'http' || proto === 'https' ? proto : 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  if (host) return `${scheme}://${host}`;
  return 'https://block-events.vercel.app';
}

function escapeXmlForSitemap(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.get('/robots.txt', (req, res) => {
  const origin = siteOriginFromRequest(req);
  res.type('text/plain');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /admin-bookings',
      'Disallow: /admin-rules',
      'Disallow: /admin-scanners',
      'Disallow: /api/',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ].join('\n'),
  );
});

app.get('/sitemap.xml', async (req, res) => {
  const origin = siteOriginFromRequest(req);
  const staticPaths = ['/', '/events', '/about-us', '/contact', '/faq', '/register', '/event'];
  let events = [];
  try {
    events = await listEventsForPublic({ lite: true });
  } catch (e) {
    events = [];
  }
  const eventPaths = new Set();
  for (const ev of events || []) {
    if (!ev) continue;
    const key = String(ev.slug || ev.id || '').trim();
    if (!key) continue;
    eventPaths.add(`/event/${encodeURIComponent(key)}`);
  }
  const paths = [...staticPaths, ...eventPaths];
  const today = new Date().toISOString().slice(0, 10);
  const lines = paths.map((p) => {
    const loc = `${origin}${p}`;
    const priority = p === '/' ? '1.0' : p.startsWith('/event/') ? '0.9' : '0.8';
    const freq = p === '/' || p === '/events' ? 'daily' : 'weekly';
    return `  <url>\n    <loc>${escapeXmlForSitemap(loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${freq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  });
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    lines.join('\n') +
    `\n</urlset>`;
  res.type('application/xml');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(xml);
});

app.post('/api/register', async (req, res) => {
  const { name, email, phone, eventId } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const eventRow = eventId && supabase ? await resolveEventRowByIdOrSlug(String(eventId)) : null;
  const event = eventId ? await getEventById(eventId) : null;
  const eventName = eventRow ? eventRow.name : event ? event.name : (process.env.EVENT_NAME || 'Event');
  const attendeeEventId = eventRow ? eventRow.id : eventId || null;
  const blocked = await isUserBlocked(email.trim(), (phone || '').trim());
  if (blocked) {
    return res.status(403).json({ error: 'This email or phone is blocked from registering.' });
  }
  const existing = await findExistingRegistration(email.trim(), (phone || '').trim(), attendeeEventId || eventId || null, eventName);
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
      eventId: attendeeEventId,
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

function isHomeNavUrl(u) {
  const s = String(u || '').trim();
  if (!s || s === '/') return true;
  try {
    if (/^https?:\/\//i.test(s)) {
      const p = new URL(s, 'http://localhost').pathname.replace(/\/$/, '') || '/';
      return p === '/';
    }
  } catch (_) {
    /* ignore */
  }
  const p = s.split('?')[0].replace(/\/$/, '') || '/';
  return p === '/';
}

/** Keep a single Home (/) link first in nav lists (Tazkarti-style). */
function ensureHomeFirst(links) {
  const arr = Array.isArray(links)
    ? links.filter((l) => l && (l.label || l.url)).map((l) => ({ ...l }))
    : [];
  const i = arr.findIndex((l) => l && isHomeNavUrl(l.url));
  if (i === -1) return [{ label: 'Home', url: '/' }, ...arr];
  if (i === 0) return arr;
  const home = arr[i];
  const rest = arr.filter((_, j) => j !== i);
  return [home, ...rest];
}

const SOCIAL_NETWORK_IDS = ['facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'tiktok'];

function defaultSocialLinkRows() {
  return SOCIAL_NETWORK_IDS.map((id) => ({
    id,
    url: '',
    label: id.charAt(0).toUpperCase() + id.slice(1),
    visible: true,
  }));
}

function socialLinkRowVisible(item) {
  if (!item || typeof item !== 'object') return true;
  const v = item.visible;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return true;
}

/** Merge file + legacy instagram fields into a fixed-order social link list for the API and UI. */
function normalizeSocialLinks(parsed) {
  const byId = new Map(defaultSocialLinkRows().map((row) => [row.id, { ...row }]));
  if (parsed && Array.isArray(parsed.socialLinks)) {
    for (const item of parsed.socialLinks) {
      if (!item || !item.id) continue;
      const id = String(item.id).trim().toLowerCase();
      if (!byId.has(id)) continue;
      const cur = byId.get(id);
      cur.url = String(item.url || '').trim();
      if (item.label != null && String(item.label).trim()) cur.label = String(item.label).trim();
      cur.visible = socialLinkRowVisible(item);
    }
  }
  const igUrl = parsed && String(parsed.instagramUrl || '').trim();
  const igLabel = parsed && String(parsed.instagramLabel || '').trim();
  const igRow = byId.get('instagram');
  if (igUrl && igRow && igRow.visible !== false) {
    if (!igRow.url) igRow.url = igUrl;
    if (igLabel) igRow.label = igLabel;
  }
  return SOCIAL_NETWORK_IDS.map((id) => {
    const row = byId.get(id);
    return { ...row, visible: row.visible !== false };
  });
}

function defaultPaymentMethodsConfig() {
  return [
    { id: 'card', label: 'Card', enabled: true, description: 'Visa, Mastercard (configure gateway later).' },
    { id: 'fawry', label: 'Fawry', enabled: true, description: 'Fawry payments (configure merchant later).' },
    { id: 'instapay', label: 'InstaPay', enabled: true, description: 'Bank transfer / QR approval flow.' },
  ];
}

function getSiteConfig() {
  try {
    const raw = fs.readFileSync(SITE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.paymentMethods) || !parsed.paymentMethods.length) {
      parsed.paymentMethods = defaultPaymentMethodsConfig();
    }
    parsed.links = ensureHomeFirst(Array.isArray(parsed.links) ? parsed.links : []);
    const headerFromFile = Array.isArray(parsed.headerLinks) && parsed.headerLinks.length;
    const footerFromFile = Array.isArray(parsed.footerLinks) && parsed.footerLinks.length;
    if (!headerFromFile) parsed.headerLinks = parsed.links.slice();
    else parsed.headerLinks = ensureHomeFirst(parsed.headerLinks);
    if (!footerFromFile) parsed.footerLinks = parsed.links.slice();
    else parsed.footerLinks = ensureHomeFirst(parsed.footerLinks);
    parsed.socialLinks = normalizeSocialLinks(parsed);
    const ig = parsed.socialLinks.find((s) => s.id === 'instagram');
    const igShown = ig && ig.visible !== false;
    parsed.instagramUrl = igShown && ig.url ? ig.url : '';
    parsed.instagramLabel =
      igShown && ig.label ? ig.label : String(parsed.instagramLabel || 'Instagram').trim() || 'Instagram';
    if (!Array.isArray(parsed.promoCodes)) parsed.promoCodes = [];
    return parsed;
  } catch (e) {
    const links = [
      { label: 'Home', url: '/' },
      { label: 'Events', url: '/events' },
      { label: 'My tickets', url: '/my-tickets' },
      { label: 'Contact Us', url: '/contact' },
      { label: 'About', url: '/about-us' },
    ];
    const nav = ensureHomeFirst(links);
    const socialFallback = normalizeSocialLinks({
      instagramUrl: 'https://www.instagram.com/blockagency.eg',
      instagramLabel: 'Instagram',
    });
    const ig0 = socialFallback.find((s) => s.id === 'instagram');
    return {
      copyright: '© BLOCK',
      instagramUrl: ig0 && ig0.url ? ig0.url : '',
      instagramLabel: ig0 && ig0.label ? ig0.label : 'Instagram',
      socialLinks: socialFallback,
      paymentMethods: defaultPaymentMethodsConfig(),
      links: nav,
      headerLinks: nav.slice(),
      footerLinks: nav.slice(),
      promoCodes: [],
    };
  }
}

function resolvePromoInList(list, input) {
  const arr = Array.isArray(list) ? list : [];
  const u = String(input || '').trim().toUpperCase();
  if (!u) return null;
  for (const p of arr) {
    if (!p || typeof p !== 'object' || p.active === false) continue;
    const c = String(p.code || '').trim().toUpperCase();
    if (c !== u) continue;
    const pct = p.percentOff != null ? Number(p.percentOff) : NaN;
    const amt = p.amountOffEgp != null ? Number(p.amountOffEgp) : NaN;
    if (Number.isFinite(pct) && pct > 0) return { code: c, percentOff: Math.min(100, Math.max(0, pct)) };
    if (Number.isFinite(amt) && amt > 0) return { code: c, amountOffEgp: amt };
  }
  return null;
}

/** When Supabase is configured, promo codes may live in public.app_settings (Vercel-safe). */
async function fetchPromoCodesFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('promo_codes')
      .eq('id', 'global')
      .maybeSingle();
    if (error) {
      const msg = String(error.message || '');
      if (/does not exist|42P01|Could not find the table/i.test(msg)) {
        console.warn('app_settings missing — run app_settings block in supabase-production-deltas.sql');
        return null;
      }
      console.error('app_settings promo read:', error.message);
      return null;
    }
    if (!data) return [];
    return Array.isArray(data.promo_codes) ? data.promo_codes : [];
  } catch (e) {
    console.error('app_settings promo read exception:', e.message);
    return null;
  }
}

async function upsertPromoCodesToSupabase(codes) {
  if (!supabase) throw new Error('Supabase not configured.');
  const { error } = await supabase.from('app_settings').upsert(
    {
      id: 'global',
      promo_codes: codes,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(error.message);
}

async function getPromoCodesListForResolution() {
  if (supabase) {
    const fromDb = await fetchPromoCodesFromSupabase();
    if (fromDb !== null) return fromDb;
  }
  const cfg = getSiteConfig();
  return Array.isArray(cfg.promoCodes) ? cfg.promoCodes : [];
}

async function resolveActivePromoCodeAsync(input) {
  const list = await getPromoCodesListForResolution();
  return resolvePromoInList(list, input);
}

/** File-based promo list only (sync). Prefer resolveActivePromoCodeAsync in async routes when Supabase is on. */
function resolveActivePromoCode(input) {
  const cfg = getSiteConfig();
  const list = Array.isArray(cfg.promoCodes) ? cfg.promoCodes : [];
  return resolvePromoInList(list, input);
}

function computePromoDiscountCents(totalCents, promo) {
  if (!promo || !Number.isFinite(totalCents) || totalCents <= 0) return 0;
  if (promo.percentOff != null && promo.percentOff > 0) {
    return Math.min(totalCents, Math.floor((totalCents * promo.percentOff) / 100));
  }
  if (promo.amountOffEgp != null && promo.amountOffEgp > 0) {
    const off = Math.round(Number(promo.amountOffEgp) * 100);
    return Math.min(totalCents, Math.max(0, off));
  }
  return 0;
}

function splitOrderLinePaidCents(lineSubtotalCents, payableTotalCents) {
  const n = lineSubtotalCents.length;
  if (!n) return [];
  const sum = lineSubtotalCents.reduce((a, b) => a + b, 0);
  if (sum <= 0) return lineSubtotalCents.map(() => 0);
  const target = Math.min(Math.max(0, payableTotalCents), sum);
  let acc = 0;
  return lineSubtotalCents.map((w, i) => {
    if (i === n - 1) return Math.max(0, target - acc);
    const part = Math.floor((target * w) / sum);
    acc += part;
    return part;
  });
}

function pricePaidListForCartWithPromo(cart, promo) {
  const lineCents = cart.items.map((i) => Math.round(Number(i.selectionsTotal || i.price || 0) * 100));
  const totalCents = lineCents.reduce((a, b) => a + b, 0);
  const discountCents = computePromoDiscountCents(totalCents, promo);
  const payableCents = Math.max(0, totalCents - discountCents);
  const paidCents = splitOrderLinePaidCents(lineCents, payableCents);
  return {
    totalCents,
    discountCents,
    payableCents,
    pricePaid: paidCents.map((c) => c / 100),
  };
}

app.get('/api/site-config', (req, res) => {
  const c = getSiteConfig();
  const { promoCodes: _omit, ...rest } = c;
  res.json(rest);
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
  const prev = getSiteConfig();
  const mapLinks = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter((l) => l && (l.label || l.url))
      .map((l) => ({ label: String(l.label || '').trim(), url: String(l.url || '').trim() }));
  const socialMerge = { ...prev };
  if (Array.isArray(body.socialLinks)) socialMerge.socialLinks = body.socialLinks;
  if (body.instagramUrl != null) socialMerge.instagramUrl = body.instagramUrl;
  if (body.instagramLabel != null) socialMerge.instagramLabel = body.instagramLabel;
  const socialLinks = normalizeSocialLinks(socialMerge);
  const igRow = socialLinks.find((s) => s.id === 'instagram');
  const igShown = igRow && igRow.visible !== false;
  const config = {
    copyright: (body.copyright || '© BLOCK').trim(),
    instagramUrl: igShown && igRow.url ? igRow.url : '',
    instagramLabel: igShown && igRow.label ? igRow.label : 'Instagram',
    socialLinks,
    links: ensureHomeFirst(Array.isArray(body.links) ? mapLinks(body.links) : prev.links),
    headerLinks: ensureHomeFirst(
      Array.isArray(body.headerLinks) ? mapLinks(body.headerLinks) : (prev.headerLinks || prev.links).slice(),
    ),
    footerLinks: ensureHomeFirst(
      Array.isArray(body.footerLinks) ? mapLinks(body.footerLinks) : (prev.footerLinks || prev.links).slice(),
    ),
    ctaText: body.ctaText != null ? String(body.ctaText).trim() : prev.ctaText,
    ctaUrl: body.ctaUrl != null ? String(body.ctaUrl).trim() : prev.ctaUrl,
    paymentMethods: Array.isArray(body.paymentMethods)
      ? body.paymentMethods
          .filter((m) => m && m.id)
          .map((m) => ({
            id: String(m.id || '').trim().toLowerCase(),
            label: String(m.label || m.id || '').trim(),
            enabled: m.enabled !== false,
            description: String(m.description || '').trim(),
          }))
      : prev.paymentMethods || defaultPaymentMethodsConfig(),
    promoCodes: Array.isArray(body.promoCodes)
      ? body.promoCodes
          .filter((p) => p && String(p.code || '').trim())
          .map((p) => {
            const row = {
              code: String(p.code || '').trim(),
              active: p.active !== false,
            };
            if (p.percentOff != null) row.percentOff = Number(p.percentOff);
            if (p.amountOffEgp != null) row.amountOffEgp = Number(p.amountOffEgp);
            return row;
          })
      : Array.isArray(prev.promoCodes)
        ? prev.promoCodes
        : [],
  };
  try {
    fs.writeFileSync(SITE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json(config);
   } catch (e) {
    console.error('Site config write error:', e.message);
    res.status(500).json({ error: 'Could not save site config.' });
  }
});

function readSiteConfigFileObject() {
  try {
    return JSON.parse(fs.readFileSync(SITE_CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** Admin promo UI: percentage off cart total only; deduped by code (case-insensitive). */
function normalizePromoCodesAdminPayload(list) {
  if (!Array.isArray(list)) return [];
  const byCode = new Map();
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const code = String(p.code || '').trim().toUpperCase();
    if (!code) continue;
    const pct = Math.min(100, Math.max(0, Math.round(Number(p.percentOff) || 0)));
    if (pct <= 0) continue;
    byCode.set(code, { code, percentOff: pct, active: p.active !== false });
  }
  return Array.from(byCode.values());
}

app.get('/api/admin/promo-codes', async (req, res) => {
  if (!isLocalhostRequest(req)) {
    if (!process.env.ADMIN_API_KEY) {
      return res.status(503).json({ error: 'ADMIN_API_KEY not set on server.' });
    }
    if (!isAdminRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  }
  let raw = null;
  if (supabase) {
    raw = await fetchPromoCodesFromSupabase();
  }
  if (raw === null) {
    const cfg = getSiteConfig();
    raw = Array.isArray(cfg.promoCodes) ? cfg.promoCodes : [];
  }
  const promoCodes = raw
    .filter((p) => p && String(p.code || '').trim())
    .map((p) => ({
      code: String(p.code || '').trim().toUpperCase(),
      percentOff:
        p.percentOff != null ? Math.min(100, Math.max(0, Math.round(Number(p.percentOff)))) : 0,
      active: p.active !== false,
    }))
    .filter((p) => p.percentOff > 0);
  res.json({ promoCodes });
});

async function adminPromoCodesSaveHandler(req, res) {
  if (!isLocalhostRequest(req)) {
    if (!process.env.ADMIN_API_KEY) {
      return res.status(503).json({ error: 'ADMIN_API_KEY not set on server.' });
    }
    if (!isAdminRequest(req)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  }
  const normalized = normalizePromoCodesAdminPayload(req.body?.promoCodes);

  if (supabase) {
    try {
      await upsertPromoCodesToSupabase(normalized);
      return res.json({ promoCodes: normalized });
    } catch (e) {
      console.error('Promo codes save (Supabase):', e.message);
      const msg = String(e.message || '');
      const missingTable = /does not exist|42P01|Could not find the table/i.test(msg);
      return res.status(500).json({
        error: missingTable
          ? 'Add the app_settings table in Supabase: open supabase-production-deltas.sql, run the “Promo codes / app_settings” block in SQL Editor, then save again.'
          : msg || 'Could not save promo codes.',
      });
    }
  }

  const raw = readSiteConfigFileObject();
  const base =
    raw && typeof raw === 'object' ? { ...raw } : JSON.parse(JSON.stringify(getSiteConfig()));
  base.promoCodes = normalized;
  try {
    fs.writeFileSync(SITE_CONFIG_PATH, JSON.stringify(base, null, 2), 'utf8');
    res.json({ promoCodes: normalized });
  } catch (e) {
    console.error('Promo codes save error:', e.message);
    const msg = String(e.message || '');
    const readOnly =
      /EROFS|read-only|EPERM|EINVAL/i.test(msg) ||
      (process.env.VERCEL && /EACCES|ENOENT/i.test(msg));
    return res.status(500).json({
      error: readOnly
        ? 'Cannot write site-config.json on this host (read-only filesystem, e.g. Vercel). Configure Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), run the app_settings SQL in supabase-production-deltas.sql, then save again.'
        : 'Could not save promo codes.',
    });
  }
}

app.put('/api/admin/promo-codes', (req, res) => {
  adminPromoCodesSaveHandler(req, res).catch((e) => {
    console.error('adminPromoCodesSaveHandler:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Could not save promo codes.' });
  });
});
app.post('/api/admin/promo-codes', (req, res) => {
  adminPromoCodesSaveHandler(req, res).catch((e) => {
    console.error('adminPromoCodesSaveHandler:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Could not save promo codes.' });
  });
});

// ----- Admin events API (Supabase-backed) -----

app.get('/api/admin/events', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.json(loadAdminEventsFromFile());
  try {
    const { data, error } = await supabase
      .from('events')
      .select('id, slug, name, date, time, venue, category, image, image_card, image_detail, description, price, sort_order, available_tickets, created_at, extra')
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Supabase admin list events error:', error.message);
      return res.json(loadAdminEventsFromFile());
    }
    const adminEvents = (data || []).map((row) => mapSupabaseEventRowToAdmin(row));
    const withUsage = await Promise.all(
      adminEvents.map(async (ev) => {
        try {
          const booked = await getBookedCountsForEvent(ev.id);
          const tickets = Array.isArray(ev.tickets) ? ev.tickets : [];
          const enrichedTickets = tickets.map((t, idx) => {
            const key =
              normalizeTicketKey(t && (t.ticketId ?? t.id)) ||
              normalizeTicketKey(t && (t.ticketCategory ?? t.category)) ||
              normalizeTicketKey(t && (t.ticketName ?? t.name)) ||
              `cat_${idx + 1}`;
            const capRaw =
              t && t.available != null ? t.available : t && t.available_tickets != null ? t.available_tickets : null;
            const cap = capRaw != null && capRaw !== '' ? Math.max(0, parseInt(capRaw, 10) || 0) : null;
            const used = booked && booked.byKey instanceof Map ? booked.byKey.get(key) || 0 : 0;
            return {
              ...t,
              booked: used,
              remaining: cap != null ? Math.max(0, cap - used) : null,
            };
          });
          return { ...ev, tickets: enrichedTickets };
        } catch (usageErr) {
          console.warn('admin events usage calc failed:', usageErr && usageErr.message ? usageErr.message : usageErr);
          return ev;
        }
      })
    );
    res.json(withUsage);
  } catch (e) {
    console.error('Supabase admin list events exception:', e.message);
    res.json(loadAdminEventsFromFile());
  }
});

app.post('/api/admin/events', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { name, slug, date, time, venue, category, description, available_tickets, price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const normalizedPrice = price != null && price !== '' ? Number(price) : 0;
  const normalizedAvailable = available_tickets != null && available_tickets !== '' ? parseInt(available_tickets, 10) : null;
  const extraPayload = buildExtraFromAdminBody(req.body);
  const imgs = await deriveEventImagesFromAdminBodyAsync(req.body);
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
      image: imgs.image,
      image_card: imgs.image_card,
      image_detail: imgs.image_detail,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
      extra: extraPayload,
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
      image: imgs.image,
      image_card: imgs.image_card,
      image_detail: imgs.image_detail,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
      extra: extraPayload,
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
        image: imgs.image,
        image_card: imgs.image_card,
        image_detail: imgs.image_detail,
        description: description || null,
        price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
        available_tickets: normalizedAvailable,
        extra: extraPayload,
      };
      events.push(newEvent);
      setEventsToFile(events);
      return res.json({ id: newEvent.id, slug: newEvent.slug });
    }
    invalidateEventsJsonCache();
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
      image: imgs.image,
      image_card: imgs.image_card,
      image_detail: imgs.image_detail,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
      extra: extraPayload,
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
  const { name, slug, date, time, venue, category, description, available_tickets, price } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const normalizedPrice = price != null && price !== '' ? Number(price) : 0;
  const normalizedAvailable = available_tickets != null && available_tickets !== '' ? parseInt(available_tickets, 10) : null;
  const extraPayload = buildExtraFromAdminBody(req.body);
  const imgs = await deriveEventImagesFromAdminBodyAsync(req.body);
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
      image: imgs.image,
      image_card: imgs.image_card,
      image_detail: imgs.image_detail,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
      extra: extraPayload,
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
      image: imgs.image,
      image_card: imgs.image_card,
      image_detail: imgs.image_detail,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
      extra: extraPayload,
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
        image: imgs.image,
        image_card: imgs.image_card,
        image_detail: imgs.image_detail,
        description: description || null,
        price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
        available_tickets: normalizedAvailable,
        extra: extraPayload,
      };
      setEventsToFile(events);
      return res.json({ id: events[idx].id, slug: events[idx].slug || null });
    }
    invalidateEventsJsonCache();
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
      image: imgs.image,
      image_card: imgs.image_card,
      image_detail: imgs.image_detail,
      description: description || null,
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
      available_tickets: normalizedAvailable,
      extra: extraPayload,
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
    invalidateEventsJsonCache();
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
    // Use UPDATE only — upsert with partial rows can hit the INSERT path and violate NOT NULL on `name`.
    const results = await Promise.all(
      order.map((id, index) =>
        supabase.from('events').update({ sort_order: index + 1 }).eq('id', id)
      )
    );
    const error = results.find((r) => r.error)?.error;
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
    invalidateEventsJsonCache();
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
    const { data, error } = await queryAdminAttendeesRows(eventId, eventName);
    if (error) {
      console.error('Supabase admin attendees error:', error.message, error.code, error.details);
      return res.status(500).json({
        error: 'Could not load attendees.',
        details: error.message || null,
        code: error.code || null,
      });
    }
    res.json(data || []);
  } catch (e) {
    console.error('Admin attendees exception:', e.message);
    res.status(500).json({ error: 'Could not load attendees.', details: e.message || null });
  }
});

// Ticket-level payment rows (same people as attendees; joins booking data for admin)
app.get('/api/admin/payments', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  const eventId = (req.query.eventId || '').toString().trim();
  const eventName = (req.query.eventName || '').toString().trim();
  try {
    const { data, error } = await queryAdminAttendeesRows(eventId, eventName);
    if (error) {
      console.error('Supabase admin payments error:', error.message, error.code, error.details);
      return res.status(500).json({
        error: 'Could not load payments.',
        details: error.message || null,
        code: error.code || null,
      });
    }
    const enriched = await enrichAttendeeRowsForAdmin(data || []);
    try {
      res.type('application/json').send(
        JSON.stringify(enriched, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
      );
    } catch (serErr) {
      console.error('Admin payments JSON error:', serErr.message);
      res.status(500).json({ error: 'Could not load payments.', details: serErr.message || null });
    }
  } catch (e) {
    console.error('Admin payments exception:', e.message);
    res.status(500).json({ error: 'Could not load payments.', details: e.message || null });
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

// Registered website users (app_users) — list / edit / delete (no password_hash in responses)
const APP_USER_ADMIN_SELECT =
  'id, name, email, phone, birthdate, gender, profile_picture_url, created_at, updated_at';

app.get('/api/admin/users', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  try {
    const { data, error } = await supabase
      .from('app_users')
      .select(APP_USER_ADMIN_SELECT)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Admin list users error:', error.message);
      return res.status(500).json({ error: 'Could not load users.', details: error.message });
    }
    res.json(data || []);
  } catch (e) {
    console.error('Admin list users exception:', e.message);
    res.status(500).json({ error: 'Could not load users.', details: e.message });
  }
});

app.put('/api/admin/users/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  const { id } = req.params;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const body = req.body || {};
  const name = body.name != null ? String(body.name).trim() : undefined;
  const email = body.email != null ? String(body.email).trim().toLowerCase() : undefined;
  const phone = body.phone != null ? String(body.phone).trim() || null : undefined;
  let birthdate =
    body.birthdate != null && String(body.birthdate).trim() !== ''
      ? String(body.birthdate).trim()
      : body.birthdate === null
        ? null
        : undefined;
  if (birthdate === '') birthdate = null;
  const gender = body.gender != null ? String(body.gender).trim() || null : undefined;
  const profilePictureUrl =
    body.profile_picture_url != null ? String(body.profile_picture_url).trim() || null : undefined;
  const newPassword = body.newPassword != null ? String(body.newPassword) : '';

  if (email !== undefined) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }
    const { data: clash, error: clashErr } = await supabase
      .from('app_users')
      .select('id')
      .eq('email', email)
      .neq('id', id)
      .maybeSingle();
    if (clashErr) {
      console.error('Admin user email check error:', clashErr.message);
      return res.status(500).json({ error: clashErr.message });
    }
    if (clash) {
      return res.status(409).json({ error: 'Another account already uses this email.' });
    }
  }

  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined) patch.name = name || null;
  if (email !== undefined) patch.email = email;
  if (phone !== undefined) patch.phone = phone;
  if (birthdate !== undefined) patch.birthdate = birthdate;
  if (gender !== undefined) patch.gender = gender;
  if (profilePictureUrl !== undefined) patch.profile_picture_url = profilePictureUrl;

  if (newPassword.trim()) {
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    patch.password_hash = await bcrypt.hash(newPassword.trim(), 10);
    patch.password_reset_token_hash = null;
    patch.password_reset_expires_at = null;
  }

  try {
    const { data, error } = await supabase
      .from('app_users')
      .update(patch)
      .eq('id', id)
      .select(APP_USER_ADMIN_SELECT)
      .maybeSingle();
    if (error) {
      console.error('Admin update user error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(data);
  } catch (e) {
    console.error('Admin update user exception:', e.message);
    res.status(500).json({ error: 'Could not update user.', details: e.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured.' });
  }
  const { id } = req.params;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  try {
    const { data: userRow, error: fetchErr } = await supabase
      .from('app_users')
      .select('email')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) {
      console.error('Admin delete user fetch error:', fetchErr.message);
      return res.status(500).json({ error: fetchErr.message });
    }
    if (!userRow || !userRow.email) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const em = String(userRow.email).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const { error: attErr } = await supabase.from('attendees').delete().ilike('email', em);
    if (attErr) {
      console.error('Admin delete user attendees cleanup error:', attErr.message);
      return res.status(500).json({ error: attErr.message });
    }
    const { error: delErr } = await supabase.from('app_users').delete().eq('id', id);
    if (delErr) {
      console.error('Admin delete user error:', delErr.message);
      return res.status(500).json({ error: delErr.message });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin delete user exception:', e.message);
    res.status(500).json({ error: 'Could not delete user.', details: e.message });
  }
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

// ----- Scanner profile auth + server-side history -----
// Public: show scanner profile label on the login screen (no secrets).
app.get('/api/scanner/public-info', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const scannerId = String(req.query.scannerId || '').trim();
  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(scannerId)) return res.status(400).json({ error: 'Invalid scanner id.' });

  const { data, error } = await supabase
    .from('scanners')
    .select('id, name, active')
    .eq('id', scannerId)
    .maybeSingle();
  if (error || !data || !data.active) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true, scanner: { id: data.id, name: data.name } });
});

app.post('/api/scanner/logout', (req, res) => {
  clearScannerCookie(res);
  res.json({ ok: true });
});

// Scanner enters name only; admin must approve before this device can scan.
app.post('/api/scanner/request-access', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const scannerId = String(req.body?.scannerId || '').trim();
  const deviceId = String(req.body?.deviceId || '').trim();
  const requestedName = String(req.body?.requestedName || req.body?.operatorName || '').trim();

  if (!scannerId || !deviceId) return res.status(400).json({ error: 'scannerId and deviceId are required.' });
  if (requestedName.length < 2) {
    return res.status(400).json({ error: 'Enter your name (at least 2 characters).' });
  }

  const { data: scanner, error: scErr } = await supabase
    .from('scanners')
    .select('id, name, active')
    .eq('id', scannerId)
    .maybeSingle();
  if (scErr || !scanner || !scanner.active) {
    return res.status(404).json({ error: 'Scanner not found or inactive.' });
  }

  await supabase
    .from('scanner_access_requests')
    .delete()
    .eq('scanner_id', scannerId)
    .eq('device_id', deviceId)
    .eq('status', 'pending');

  const { data: inserted, error: insErr } = await supabase
    .from('scanner_access_requests')
    .insert({
      scanner_id: scannerId,
      device_id: deviceId,
      requested_name: requestedName,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insErr) {
    return res.status(400).json({ error: insErr.message || 'Could not submit request.' });
  }
  res.json({ ok: true, requestId: inserted.id });
});

app.get('/api/scanner/access-status', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const scannerId = String(req.query.scannerId || '').trim();
  const deviceId = String(req.query.deviceId || '').trim();
  if (!scannerId || !deviceId) return res.status(400).json({ error: 'scannerId and deviceId are required.' });

  const { data: ready } = await supabase
    .from('scanner_access_requests')
    .select('id, approval_token, requested_name')
    .eq('scanner_id', scannerId)
    .eq('device_id', deviceId)
    .eq('status', 'approved')
    .is('consumed_at', null)
    .not('approval_token', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (ready?.approval_token) {
    return res.json({
      ok: true,
      phase: 'ready',
      approvalToken: ready.approval_token,
      requestedName: ready.requested_name,
    });
  }

  const { data: pend } = await supabase
    .from('scanner_access_requests')
    .select('id, requested_name, created_at')
    .eq('scanner_id', scannerId)
    .eq('device_id', deviceId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pend) {
    return res.json({
      ok: true,
      phase: 'pending',
      requestId: pend.id,
      requestedName: pend.requested_name,
    });
  }

  return res.json({ ok: true, phase: 'idle' });
});

app.post('/api/scanner/complete-activation', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const scannerId = String(req.body?.scannerId || '').trim();
  const deviceId = String(req.body?.deviceId || '').trim();
  const approvalToken = String(req.body?.approvalToken || '').trim();
  if (!scannerId || !deviceId || !approvalToken) {
    return res.status(400).json({ error: 'scannerId, deviceId, and approvalToken are required.' });
  }

  const { data: row, error: rowErr } = await supabase
    .from('scanner_access_requests')
    .select('id, requested_name, scanner_id')
    .eq('scanner_id', scannerId)
    .eq('device_id', deviceId)
    .eq('approval_token', approvalToken)
    .eq('status', 'approved')
    .is('consumed_at', null)
    .maybeSingle();

  if (rowErr || !row) return res.status(401).json({ error: 'Invalid or expired activation.' });

  const { data: scanner, error: scErr } = await supabase
    .from('scanners')
    .select('id, name, active')
    .eq('id', scannerId)
    .maybeSingle();
  if (scErr || !scanner || !scanner.active) {
    return res.status(403).json({ error: 'Scanner inactive.' });
  }

  const operatorName = String(row.requested_name || '').trim() || 'Scanner';
  const token = signScannerSessionToken({ scannerId: scanner.id, deviceId, operatorName });
  setScannerCookie(res, token);

  const { error: devErr } = await supabase.from('scanner_devices').upsert(
    {
      scanner_id: scanner.id,
      device_id: deviceId,
      last_seen: new Date().toISOString(),
      operator_name: operatorName,
    },
    { onConflict: 'scanner_id,device_id' }
  );
  if (devErr) {
    // non-fatal
  }

  await supabase
    .from('scanner_access_requests')
    .update({ approval_token: null, consumed_at: new Date().toISOString() })
    .eq('id', row.id);

  res.json({
    ok: true,
    scanner: { id: scanner.id, name: scanner.name },
    operatorName,
  });
});

app.post('/api/scanner/ping', async (req, res) => {
  const session = await requireScannerSession(req, res);
  if (!session) return;
  const { scannerId, deviceId, operatorName } = session;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const { error } = await supabase.from('scanner_devices').upsert(
    {
      scanner_id: scannerId,
      device_id: deviceId,
      last_seen: new Date().toISOString(),
      operator_name: operatorName || null,
    },
    { onConflict: 'scanner_id,device_id' }
  );
  if (error) return res.status(500).json({ error: 'Ping failed.' });
  res.json({ ok: true });
});

app.get('/api/scanner/me', async (req, res) => {
  const session = await requireScannerSession(req, res);
  if (!session) return;
  res.json({
    ok: true,
    scanner: { id: session.scannerId, name: session.scanner?.name },
    operatorName: session.operatorName,
  });
});

app.get('/api/scanner/history', async (req, res) => {
  const session = await requireScannerSession(req, res);
  if (!session) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || 25), 10) || 25));
  const deviceId = String(req.query.deviceId || session.deviceId || '').trim() || session.deviceId;

  const { data, error } = await supabase
    .from('scanner_scan_logs')
    .select('created_at, status, ticket_id, event_name, user_name, user_email, ticket_category, ticket_number, event_id, checkin_time')
    .eq('scanner_id', session.scannerId)
    .eq('device_id', deviceId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: 'Could not load history.' });

  res.json({ ok: true, logs: (data || []).map((row) => ({ at: row.created_at, status: row.status, ticketId: row.ticket_id, eventName: row.event_name, userName: row.user_name, userEmail: row.user_email, ticketCategory: row.ticket_category, ticketNumber: row.ticket_number })) });
});

app.post('/api/scanner/scan-ticket', async (req, res) => {
  const session = await requireScannerSession(req, res);
  if (!session) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const { scannerId, deviceId, operatorName } = session;

  const ticketId = String(req.body?.ticket_id || req.body?.ticketId || '').trim();
  if (!ticketId) return res.status(400).json({ status: 'invalid', message: 'Ticket not found' });

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

  const insertLog = async (payload) => {
    try {
      await supabase.from('scanner_scan_logs').insert({
        scanner_id: payload.scannerId,
        device_id: payload.deviceId,
        operator_name: payload.operatorName || null,
        ticket_id: payload.ticketId,
        status: payload.status,
        user_name: payload.userName || null,
        user_email: payload.userEmail || null,
        event_id: payload.eventId || null,
        event_name: payload.eventName || null,
        ticket_category: payload.ticketCategory || null,
        ticket_number: payload.ticketNumber || null,
        checkin_time: payload.checkinTime || null,
      });
    } catch (e) {}
  };

  if (updatedRow) {
    await insertLog({
      scannerId,
      deviceId,
      operatorName,
      ticketId,
      status: 'success',
      userName: updatedRow.name,
      userEmail: updatedRow.email,
      eventId: updatedRow.event_id,
      eventName: updatedRow.event_name,
      ticketCategory: updatedRow.ticket_category,
      ticketNumber: updatedRow.ticket_number,
      checkinTime: updatedRow.checkin_time,
    });

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

  const { data: existing } = await supabase
    .from('attendees')
    .select('id, name, email, ticket_id, event_id, event_name, ticket_category, ticket_number, attended, checkin_time')
    .eq('ticket_id', ticketId)
    .maybeSingle();

  if (!existing) {
    await insertLog({ scannerId, deviceId, operatorName, ticketId, status: 'invalid' });
    return res.json({ status: 'invalid', message: 'Ticket not found' });
  }

  if (existing.attended) {
    await insertLog({
      scannerId,
      deviceId,
      operatorName,
      ticketId,
      status: 'already_used',
      userName: existing.name,
      userEmail: existing.email,
      eventId: existing.event_id,
      eventName: existing.event_name,
      ticketCategory: existing.ticket_category,
      ticketNumber: existing.ticket_number,
      checkinTime: existing.checkin_time,
    });

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

  // Edge case: update failed for some other reason.
  await insertLog({ scannerId, deviceId, operatorName, ticketId, status: 'invalid' });
  return res.status(500).json({ status: 'invalid', message: 'Invalid ticket' });
});

// ----- Admin: scanner profiles + history -----
app.get('/api/admin/scanners', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.json([]);

  const { data: scanners, error: scErr } = await supabase.from('scanners').select('id, name, active, created_at');
  if (scErr) return res.status(500).json({ error: 'Could not load scanners.' });

  let devices = [];
  let devRes = await supabase
    .from('scanner_devices')
    .select('scanner_id, device_id, last_seen, operator_name')
    .order('last_seen', { ascending: false });
  if (devRes.error) {
    const retry = await supabase
      .from('scanner_devices')
      .select('scanner_id, device_id, last_seen')
      .order('last_seen', { ascending: false });
    if (retry.error) return res.status(500).json({ error: 'Could not load scanner devices.' });
    devices = (retry.data || []).map((d) => ({ ...d, operator_name: null }));
  } else {
    devices = devRes.data || [];
  }

  const now = Date.now();
  const ONLINE_WINDOW_MS = 60 * 1000;

  const devicesByScanner = {};
  devices.forEach((d) => {
    const sid = d.scanner_id;
    devicesByScanner[sid] = devicesByScanner[sid] || [];
    devicesByScanner[sid].push({
      deviceId: d.device_id,
      lastSeen: d.last_seen,
      operatorName: d.operator_name || null,
      online: d.last_seen ? now - new Date(d.last_seen).getTime() <= ONLINE_WINDOW_MS : false,
    });
  });

  // Load recent scan logs to show last scan.
  const { data: recentLogs } = await supabase
    .from('scanner_scan_logs')
    .select('scanner_id, device_id, created_at, status')
    .order('created_at', { ascending: false })
    .limit(200);

  const lastLogByScanner = {};
  (recentLogs || []).forEach((l) => {
    if (!lastLogByScanner[l.scanner_id]) lastLogByScanner[l.scanner_id] = l;
  });

  res.json(
    (scanners || []).map((s) => {
      const dList = devicesByScanner[s.id] || [];
      const anyOnline = dList.some((d) => d.online);
      const last = lastLogByScanner[s.id] || null;
      return {
        id: s.id,
        name: s.name,
        active: s.active,
        online: anyOnline,
        devices: dList,
        lastScan: last ? { at: last.created_at, status: last.status, deviceId: last.device_id } : null,
      };
    })
  );
});

app.post('/api/admin/scanners', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const name = String(req.body?.name || '').trim();
  const active = req.body?.active == null ? true : Boolean(req.body.active);
  if (!name) return res.status(400).json({ error: 'name is required.' });

  const { count, error: cErr } = await supabase.from('scanners').select('*', { count: 'exact', head: true });
  if (cErr) return res.status(500).json({ error: 'Could not count scanners.' });
  if ((count ?? 0) >= MAX_SCANNER_PROFILES) {
    return res.status(400).json({ error: `Maximum of ${MAX_SCANNER_PROFILES} scanner profiles reached.` });
  }

  let { data, error } = await supabase
    .from('scanners')
    .insert({ name, password_hash: null, active })
    .select('id, name, active')
    .single();

  if (error) {
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8);
    const retry = await supabase
      .from('scanners')
      .insert({ name, password_hash: placeholderHash, active })
      .select('id, name, active')
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error) return res.status(400).json({ error: error.message || 'Could not create scanner.' });
  res.json({ ok: true, scanner: data });
});

async function adminDeleteScannerHandler(req, res) {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const { data: deleted, error } = await supabase.from('scanners').delete().eq('id', id).select('id').maybeSingle();
  if (error) {
    console.error('Delete scanner error:', error.message, error.code, error.details);
    return res.status(500).json({
      error: error.message || 'Could not delete scanner.',
      code: error.code || null,
      details: error.details || null,
      hint: error.hint || null,
    });
  }
  if (!deleted) {
    return res.status(404).json({
      error:
        'No scanner was deleted (wrong id, or blocked). If you use Supabase RLS on public.scanners, deletes must be allowed for the service role, and the server must use SUPABASE_SERVICE_ROLE_KEY.',
    });
  }
  res.json({ ok: true });
}

app.delete('/api/admin/scanners/:id', adminDeleteScannerHandler);
// POST alias: some proxies / older setups mishandle DELETE; admin UI uses this path.
app.post('/api/admin/scanners/:id/delete', adminDeleteScannerHandler);

app.get('/api/admin/scanner-requests', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.json([]);

  const { data: rows, error } = await supabase
    .from('scanner_access_requests')
    .select('id, scanner_id, device_id, requested_name, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    const hint = String(error.message || error.details || error.hint || '').toLowerCase();
    const code = String(error.code || '');
    const tableMissing =
      code === 'PGRST205' ||
      code === '42P01' ||
      hint.includes('scanner_access_requests') ||
      (/schema cache/i.test(hint) && hint.includes('scanner_access'));
    if (tableMissing) return res.json([]);
    return res.status(500).json({ error: error.message || 'Could not load requests.' });
  }

  const ids = [...new Set((rows || []).map((r) => r.scanner_id).filter(Boolean))];
  const nameById = {};
  if (ids.length) {
    const { data: sn } = await supabase.from('scanners').select('id, name').in('id', ids);
    (sn || []).forEach((s) => {
      nameById[s.id] = s.name;
    });
  }

  res.json(
    (rows || []).map((r) => ({
      id: r.id,
      scannerId: r.scanner_id,
      scannerName: nameById[r.scanner_id] || '',
      deviceId: r.device_id,
      requestedName: r.requested_name,
      createdAt: r.created_at,
    }))
  );
});

app.post('/api/admin/scanner-requests/:requestId/approve', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const requestId = String(req.params.requestId || '').trim();
  const approvalToken = crypto.randomBytes(32).toString('hex');

  const { data, error } = await supabase
    .from('scanner_access_requests')
    .update({
      status: 'approved',
      approval_token: approvalToken,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error || !data) {
    return res.status(400).json({ error: 'Request not found or already handled.' });
  }
  res.json({ ok: true });
});

app.post('/api/admin/scanner-requests/:requestId/reject', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const requestId = String(req.params.requestId || '').trim();

  const { data, error } = await supabase
    .from('scanner_access_requests')
    .update({
      status: 'rejected',
      approval_token: null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error || !data) {
    return res.status(400).json({ error: 'Request not found or already handled.' });
  }
  res.json({ ok: true });
});

async function fetchScanLogPages(supabaseClient, selectCols, scannerId, deviceId, statusKey) {
  const rows = [];
  let from = 0;
  const step = 1000;
  for (;;) {
    let q = supabaseClient
      .from('scanner_scan_logs')
      .select(selectCols)
      .eq('scanner_id', scannerId)
      .order('id', { ascending: true })
      .range(from, from + step - 1);
    if (deviceId) q = q.eq('device_id', deviceId);
    if (statusKey && statusKey !== 'all') q = q.eq('status', statusKey);
    const { data, error } = await q;
    if (error) {
      console.error('Scanner history page fetch:', error.message);
      return { rows, error };
    }
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < step) break;
    from += step;
    if (from >= 100000) break;
  }
  return { rows, error: null };
}

function buildScannerHistoryDeviceTotals(filteredRows, repeatRows) {
  const deviceTotals = {};
  for (const row of filteredRows) {
    const d = row.device_id ? String(row.device_id) : '—';
    if (!deviceTotals[d]) {
      deviceTotals[d] = {
        total: 0,
        success: 0,
        already_used: 0,
        invalid: 0,
        ticketsWithMultiScans: 0,
      };
    }
    deviceTotals[d].total += 1;
    const st = String(row.status || '')
      .trim()
      .toLowerCase();
    if (st === 'success') deviceTotals[d].success += 1;
    else if (st === 'already_used') deviceTotals[d].already_used += 1;
    else if (st === 'invalid') deviceTotals[d].invalid += 1;
  }
  const perDevTickets = {};
  for (const row of repeatRows) {
    const d = row.device_id ? String(row.device_id) : '—';
    const t = row.ticket_id ? String(row.ticket_id).trim() : '';
    if (!t) continue;
    if (!perDevTickets[d]) perDevTickets[d] = {};
    perDevTickets[d][t] = (perDevTickets[d][t] || 0) + 1;
  }
  const devices = new Set([...Object.keys(deviceTotals), ...Object.keys(perDevTickets)]);
  for (const d of devices) {
    if (!deviceTotals[d]) {
      deviceTotals[d] = {
        total: 0,
        success: 0,
        already_used: 0,
        invalid: 0,
        ticketsWithMultiScans: 0,
      };
    }
    const counts = Object.values(perDevTickets[d] || {});
    deviceTotals[d].ticketsWithMultiScans = counts.filter((c) => c >= 2).length;
  }
  return deviceTotals;
}

app.get('/api/admin/scanner-history', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const scannerId = String(req.query.scannerId || '').trim();
  const deviceId = String(req.query.deviceId || '').trim();
  const statusFilter = String(req.query.status || 'all')
    .trim()
    .toLowerCase();
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || 25), 10) || 25));
  if (!scannerId) return res.status(400).json({ error: 'scannerId is required.' });

  const allowedStatus = new Set(['all', 'success', 'already_used', 'invalid']);
  const statusKey = allowedStatus.has(statusFilter) ? statusFilter : 'all';

  let listQ = supabase
    .from('scanner_scan_logs')
    .select(
      'created_at, status, ticket_id, event_name, user_name, user_email, ticket_category, ticket_number, device_id, operator_name'
    )
    .eq('scanner_id', scannerId);
  if (deviceId) listQ = listQ.eq('device_id', deviceId);
  if (statusKey !== 'all') listQ = listQ.eq('status', statusKey);
  listQ = listQ.order('created_at', { ascending: false }).limit(limit);

  const listPromise = listQ;
  const filteredAggPromise = fetchScanLogPages(
    supabase,
    'device_id, status, ticket_id',
    scannerId,
    deviceId,
    statusKey
  );
  const repeatPromise = fetchScanLogPages(supabase, 'device_id, ticket_id', scannerId, deviceId, 'all');

  const [listRes, filteredAggRes, repeatRes] = await Promise.all([
    listPromise,
    filteredAggPromise,
    repeatPromise,
  ]);

  if (listRes.error) return res.status(500).json({ error: 'Could not load history.' });

  const deviceTotals = buildScannerHistoryDeviceTotals(
    filteredAggRes.rows || [],
    repeatRes.rows || []
  );

  res.json({
    ok: true,
    statusFilter: statusKey,
    deviceTotals,
    logs: (listRes.data || []).map((row) => ({
      at: row.created_at,
      status: row.status,
      ticketId: row.ticket_id,
      eventName: row.event_name,
      userName: row.user_name,
      userEmail: row.user_email,
      ticketCategory: row.ticket_category,
      ticketNumber: row.ticket_number,
      deviceId: row.device_id,
      operatorName: row.operator_name,
    })),
  });
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

/** Group attendee rows by event for My Tickets UI (Tazkarti-style). */
async function buildTicketGroupsForEmail(email, bookingRowsForUser) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !supabase) return [];

  const { data: rows, error } = await supabase
    .from('attendees')
    .select(
      'ticket_id, event_name, event_id, attended, checkin_time, created_at, name, email, phone, ticket_category, ticket_number'
    )
    .eq('email', e)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase buildTicketGroups error:', error.message);
    return [];
  }

  // Avoid N+1 event lookups by resolving each unique event once.
  const eventIds = Array.from(
    new Set(
      (rows || [])
        .map((r) => String((r && r.event_id) || '').trim())
        .filter(Boolean)
    )
  );
  const eventsById = new Map();
  await Promise.all(
    eventIds.map(async (eid) => {
      const ev = await getEventById(eid);
      if (!ev) return;
      if (ev.id) eventsById.set(String(ev.id), ev);
      if (ev.slug) eventsById.set(String(ev.slug), ev);
    })
  );

  const bookingByEventId = new Map();
  for (const b of bookingRowsForUser || []) {
    const eid = String(b.event_id || '');
    if (eid && !bookingByEventId.has(eid)) bookingByEventId.set(eid, b);
  }

  const list = [];
  for (const r of rows || []) {
    const ev = r.event_id ? eventsById.get(String(r.event_id)) || null : null;
    const booking = r.event_id ? bookingByEventId.get(String(r.event_id)) : null;
    list.push({
      ticketId: r.ticket_id,
      holderName: r.name,
      eventName: r.event_name || ev?.name || 'Event',
      eventId: r.event_id,
      attended: !!r.attended,
      checkinTime: r.checkin_time,
      createdAt: r.created_at,
      category: r.ticket_category || null,
      seatLabel: r.ticket_number || null,
      image: ev?.imageCard || ev?.image || null,
      venue: ev?.venue || null,
      date: ev?.date || null,
      time: ev?.time || null,
      eventCategory: ev?.category || null,
      bookingId: booking?.id || null,
    });
  }

  const groupMap = new Map();
  for (const t of list) {
    const key = String(t.eventId || t.eventName || 'unknown');
    if (!groupMap.has(key)) {
      const bk = t.bookingId;
      groupMap.set(key, {
        eventId: t.eventId,
        eventName: t.eventName,
        eventCategory: t.eventCategory,
        venue: t.venue,
        date: t.date,
        time: t.time,
        image: t.image,
        bookingNo: bk ? `BK-${String(bk).replace(/-/g, '').slice(0, 8).toUpperCase()}` : '—',
        holderName: t.holderName,
        tickets: [],
      });
    }
    groupMap.get(key).tickets.push(t);
  }

  return Array.from(groupMap.values());
}

function formatPaymentMethodLabel(m) {
  const s = String(m || '').toLowerCase();
  if (s === 'instapay') return 'InstaPay';
  if (s === 'fawry') return 'Fawry';
  if (s === 'free') return 'FREE';
  if (s === 'applepay') return 'Apple Pay';
  if (s === 'visa' || s === 'card' || s === 'credit' || s === 'debit') return 'Card';
  return m ? String(m).charAt(0).toUpperCase() + String(m).slice(1) : '—';
}

// JSON for ticket detail modal (QR + metadata)
app.get('/api/ticket-detail/:ticketId', async (req, res) => {
  const ticketId = String(req.params.ticketId || '').trim();
  if (!ticketId) return res.status(400).json({ error: 'ticketId required.' });
  const attendee = await getAttendeeByTicketId(ticketId);
  if (!attendee) return res.status(404).json({ error: 'Ticket not found.' });
  const ev = attendee.event_id ? await getEventById(String(attendee.event_id)) : null;
  let dataUrl = '';
  try {
    const out = await generateQR(ticketId);
    dataUrl = out.dataUrl || '';
  } catch (e) {
    console.error('QR gen error:', e.message);
  }
  const checkinUrl = `${BASE_URL}/checkin/${encodeURIComponent(ticketId)}`;
  res.json({
    ticketId,
    qrDataUrl: dataUrl,
    checkinUrl,
    holderName: attendee.name,
    orderLabel: attendee.event_id
      ? `BK-${String(attendee.event_id).replace(/-/g, '').slice(0, 8).toUpperCase()}`
      : '—',
    ticketNumber: attendee.ticket_number || ticketId,
    seatLabel: attendee.ticket_number || null,
    ticketCategory: attendee.ticket_category,
    eventName: ev?.name || attendee.event_name,
    venue: ev?.venue || null,
    date: ev?.date || null,
    time: ev?.time || null,
    price: ev != null && ev.price != null ? Number(ev.price) : null,
    gatesOpen: '— : —',
    image: ev?.imageHero || ev?.image || null,
    attended: !!attendee.attended,
  });
});

// Logged-in: ticket groups + booking numbers when events match
app.get('/api/auth/my-entry-tickets', async (req, res) => {
  const user = await getAuthUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, event_id, created_at, status')
    .eq('user_id', user.id);

  const groups = await buildTicketGroupsForEmail(user.email, bookings || []);
  res.json({ groups });
});

// Payment history rows for My Tickets page
app.get('/api/auth/payment-history', async (req, res) => {
  const user = await getAuthUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });

  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, created_at, payment_method, price_paid, status, ticket_selections, event_id, events(name, venue, date, time)'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('payment-history error:', error.message);
    return res.status(500).json({ error: 'Could not load payment history.' });
  }

  const rows = (data || []).map((b) => ({
    id: b.id,
    bookingNo: `BK-${String(b.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    purchaseDate: b.created_at,
    paymentMethod: formatPaymentMethodLabel(b.payment_method),
    totalAmount: Number(b.price_paid || 0),
    shipment: '',
    status: b.status,
    eventName: b.events?.name || null,
    ticketSelections: b.ticket_selections,
  }));

  res.json({ payments: rows });
});

app.get('/api/auth/booking-detail/:id', async (req, res) => {
  const user = await getAuthUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
  const id = String(req.params.id || '').trim();
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, created_at, payment_method, price_paid, status, ticket_selections, event_id, events(name, venue, date, time, image, image_card, image_detail)'
    )
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Booking not found.' });
  const evRaw = data.events;
  const im = evRaw ? eventImageFields(evRaw) : null;
  const eventOut = evRaw
    ? Object.assign({}, evRaw, { image: im.image, imageCard: im.imageCard, imageHero: im.imageHero })
    : null;
  res.json({
    bookingNo: `BK-${String(data.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    createdAt: data.created_at,
    paymentMethod: formatPaymentMethodLabel(data.payment_method),
    pricePaid: Number(data.price_paid || 0),
    status: data.status,
    event: eventOut,
    ticketSelections: data.ticket_selections,
  });
});

// My tickets: look up registrations by email (from Supabase) — returns { groups }
app.get('/api/my-tickets', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.json({ groups: [] });
  }
  if (!supabase) {
    return res.json({ groups: [] });
  }
  const groups = await buildTicketGroupsForEmail(email, []);
  res.json({ groups });
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

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true,
    setHeaders: (res, filePath) => {
      if (/\.html?$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      if (/\.(js|css|png|jpe?g|webp|svg|ico|woff2?|gif)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      }
    },
  })
);

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
