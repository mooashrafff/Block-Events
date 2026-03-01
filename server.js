require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const QRCode = require('qrcode');

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

// ----- Supabase (for saving attendees) -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn('Supabase env vars not set – running without Supabase (only sheet/email).');
}

async function saveAttendeeToSupabase({ name, email, phone, ticketId, eventId, eventName }) {
  if (!supabase) return;
  const { error } = await supabase.from('attendees').insert({
    name,
    email,
    phone: phone || null,
    ticket_id: ticketId,
    event_id: eventId || null,
    event_name: eventName || null,
  });
  if (error) {
    console.error('Supabase insert error:', error.message);
  }
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
    .select('id, attended, email, name, event_name, event_id')
    .eq('ticket_id', ticketId)
    .maybeSingle();
  if (error) {
    console.error('Supabase get attendee error:', error.message);
    return null;
  }
  return data;
}

async function markAttendedInSupabase(ticketId) {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from('attendees')
    .update({ attended: true, checkin_time: new Date().toISOString() })
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

// Map Supabase events rows into the public event shape
function mapEventRowToPublic(row) {
  if (!row) return null;
  const id = row.slug || row.id;
  return {
    id,
    name: row.name,
    date: row.date,
    time: row.time,
    venue: row.venue,
    category: row.category,
    image: row.image || '/block-logo.png',
    description: row.description,
  };
}

// Prefer Supabase events table; fall back to JSON file
async function listEventsForPublic() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('events')
        .select('id, slug, name, date, time, venue, category, image, description, sort_order, created_at')
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
        .select('id, slug, name, date, time, venue, category, image, description')
        .or(`id.eq.${id},slug.eq.${id}`)
        .limit(1)
        .maybeSingle();
      if (!error && data) {
        return mapEventRowToPublic(data);
      }
      if (error && error.code !== 'PGRST116') {
        console.error('Supabase getEventById error:', error.message);
      }
    } catch (e) {
      console.error('Supabase getEventById exception:', e.message);
    }
  }
  return getEventsFromFile().find((e) => e.id === id) || null;
}

// ----- Admin helpers for events dashboard -----

function isAdminRequest(req) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const headerKey = (req.headers['x-admin-key'] || req.headers['X-Admin-Key'] || '').toString();
  return headerKey && headerKey === adminKey;
}

async function requireAdmin(req, res) {
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

async function markAttended(ticketId) {
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

  const supabaseUpdated = await markAttendedInSupabase(ticketId);
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
  const safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const logo = getLogoDataUrl();
  const logoImg = logo ? '<img src="' + logo + '" alt="BLOCK" width="110" height="auto" style="display:block;height:auto;max-width:110px;" />' : '<span style="font-size:24px;font-weight:700;color:#1a1a1a;">BLOCK</span>';
  const safeName = safe(name || 'there');
  const safeEvent = safe(eventName);
  const safeTicketId = safe(ticketId);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="padding:32px 28px 24px;background:linear-gradient(180deg,#f8f7f4 0%,#ffffff 100%);border-bottom:1px solid #eee;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td>${logoImg}</td></tr>
              <tr><td style="padding-top:24px;">
                <h1 style="margin:0;font-size:1.5rem;font-weight:700;color:#1a1a1a;">You're registered for ${safeEvent}</h1>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <p style="margin:0 0 16px;font-size:1rem;color:#4a4a4a;line-height:1.6;">Hi ${safeName},</p>
            <p style="margin:0 0 24px;font-size:1rem;color:#4a4a4a;line-height:1.6;">Your unique ticket is below. Show this QR code at the entrance to check in.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
              <tr><td align="center" style="padding:20px;background:#f8f8f8;border-radius:12px;">
                <img src="${dataUrl}" alt="QR Code" width="240" height="240" style="display:block;width:240px;height:240px;" />
              </td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:0.9rem;color:#888;">Ticket ID: <strong style="color:#1a1a1a;">${safeTicketId}</strong></p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px 32px;background:#f8f7f4;border-top:1px solid #eee;">
            <p style="margin:0;font-size:0.95rem;font-weight:600;color:#1a1a1a;">See you there!</p>
            <p style="margin:8px 0 0;font-size:0.8rem;color:#888;">— BLOCK Events</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ----- Routes -----

app.get('/api/events', async (req, res) => {
  const events = await listEventsForPublic();
  res.json(events || []);
});

// Admin dashboard page (simple, protect via ADMIN_API_KEY for API calls)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
          attachments: [{ filename: 'ticket-qr.png', content: buffer }],
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
  if (!process.env.ADMIN_API_KEY) {
    return res.status(503).json({ error: 'ADMIN_API_KEY not set on server.' });
  }
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized.' });
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
  const { data, error } = await supabase
    .from('events')
    .select('id, slug, name, date, time, venue, category, image, description, sort_order, available_tickets, created_at')
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Supabase admin list events error:', error.message);
    return res.status(500).json({ error: 'Could not load events.' });
  }
  res.json(data || []);
});

app.post('/api/admin/events', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { name, slug, date, time, venue, category, image, description, available_tickets } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const payload = {
    name,
    slug: slug || null,
    date: date || null,
    time: time || null,
    venue: venue || null,
    category: category || null,
    image: image || null,
    description: description || null,
    available_tickets: available_tickets != null && available_tickets !== '' ? parseInt(available_tickets, 10) : null,
  };
  const { data, error } = await supabase
    .from('events')
    .insert(payload)
    .select('id, slug')
    .single();
  if (error) {
    console.error('Supabase admin create event error:', error.message);
    return res.status(500).json({ error: 'Could not create event.' });
  }
  res.json(data);
});

app.put('/api/admin/events/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { id } = req.params;
  const { name, slug, date, time, venue, category, image, description, available_tickets } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const payload = {
    name,
    slug: slug || null,
    date: date || null,
    time: time || null,
    venue: venue || null,
    category: category || null,
    image: image || null,
    description: description || null,
    available_tickets: available_tickets != null && available_tickets !== '' ? parseInt(available_tickets, 10) : null,
  };
  const { data, error } = await supabase
    .from('events')
    .update(payload)
    .eq('id', id)
    .select('id, slug')
    .single();
  if (error) {
    console.error('Supabase admin update event error:', error.message);
    return res.status(500).json({ error: 'Could not update event.' });
  }
  res.json(data);
});

app.delete('/api/admin/events/:id', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { id } = req.params;
  const { error } = await supabase.from('events').delete().eq('id', id);
  if (error) {
    console.error('Supabase admin delete event error:', error.message);
    return res.status(500).json({ error: 'Could not delete event.' });
  }
  res.json({ success: true });
});

app.post('/api/admin/events/reorder', async (req, res) => {
  const authError = await requireAdmin(req, res);
  if (authError) return;
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of event IDs.' });
  }
  try {
    const updates = order.map((id, index) => ({ id, sort_order: index + 1 }));
    const { error } = await supabase.from('events').upsert(updates, { onConflict: 'id' });
    if (error) {
      console.error('Supabase admin reorder events error:', error.message);
      return res.status(500).json({ error: 'Could not reorder events.' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Admin reorder exception:', e.message);
    res.status(500).json({ error: 'Could not reorder events.' });
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
      .select('id, name, email, phone, event_id, event_name, attended, checkin_time, created_at, ticket_id')
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

// Optional: API for scanner app to mark check-in (returns JSON)
app.get('/api/checkin/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const attendee = await getAttendeeByTicketId(ticketId);
  if (attendee && attendee.attended) {
    return res.json({ ok: true, alreadyScanned: true });
  }
  const result = await markAttended(ticketId);
  res.json({ ...result, alreadyScanned: false });
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
