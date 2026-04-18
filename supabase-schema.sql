-- Run this in Supabase: SQL Editor → New query → paste → Run
-- Existing database? You can run `supabase-production-deltas.sql` instead for
-- idempotent upgrades (indexes + missing columns).
-- Required for gen_random_uuid() used across tables.
create extension if not exists pgcrypto;

-- Attendees table (one row per registration; unique ticket_id per person)
create table if not exists public.attendees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  ticket_id text not null unique,
  ticket_category text,
  ticket_number text,
  event_id text,
  event_name text,
  attended boolean not null default false,
  checkin_time timestamptz,
  scanned_by_name text,
  scanned_by_phone text,
  created_at timestamptz not null default now()
);

-- Index for fast lookups by ticket_id (used when scanning QR / check-in)
create index if not exists attendees_ticket_id_idx on public.attendees (ticket_id);

-- Optional: index for filtering by event
create index if not exists attendees_event_id_idx on public.attendees (event_id);

-- Simple events table for admin dashboard
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text unique, -- optional: URL slug (e.g. \"ramadan-palace\")
  name text not null,
  date text,
  time text,
  venue text,
  category text,
  image text,
  image_card text,
  image_detail text,
  description text,
  price numeric not null default 0,
  sort_order integer,
  available_tickets integer,  -- max registrations (admin only, not shown to users)
  created_at timestamptz not null default now()
);

-- Add columns if upgrading an existing DB (so older projects still work):
alter table public.events add column if not exists available_tickets integer;
alter table public.events add column if not exists price numeric not null default 0;
alter table public.events add column if not exists sort_order integer;
alter table public.events add column if not exists extra jsonb default '{}'::jsonb;

create index if not exists events_sort_order_idx on public.events (sort_order nulls last, created_at desc);

-- ---------------------------------------------------------------------------
-- Auth + booking system tables (email/password, cart, bookings, mocked payments)
-- ---------------------------------------------------------------------------

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null unique,
  password_hash text not null,
  profile_picture_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists app_users_email_idx on public.app_users (lower(email));

-- Optional profile fields (registration form)
alter table public.app_users add column if not exists phone text;
alter table public.app_users add column if not exists birthdate date;
alter table public.app_users add column if not exists gender text;
alter table public.app_users add column if not exists registration_country text;

-- Password reset (forgot-password email flow)
alter table public.app_users add column if not exists password_reset_token_hash text;
alter table public.app_users add column if not exists password_reset_expires_at timestamptz;
create index if not exists app_users_password_reset_token_idx on public.app_users (password_reset_token_hash)
 where password_reset_token_hash is not null;

-- Shopping cart: one row per user+event
create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_selections jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, event_id)
);
create index if not exists cart_items_user_id_idx on public.cart_items (user_id, created_at desc);

-- Bookings: one row per checkout (users may book the same event more than once)
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  -- App uses: paid | pending_payment | confirmed | cancelled | refunded (all plain text; no DB constraint)
  status text not null default 'confirmed',
  payment_method text, -- visa | instapay | free
  price_paid numeric not null default 0,
  ticket_selections jsonb not null default '[]'::jsonb,
  instapay_sender_phone text, -- phone the customer paid from (InstaPay pending flow)
   created_at timestamptz not null default now()
);
create index if not exists bookings_user_id_idx on public.bookings (user_id, created_at desc);
create index if not exists bookings_event_id_idx on public.bookings (event_id, created_at desc);
create index if not exists bookings_user_status_idx on public.bookings (user_id, status);

-- Link attendee rows to checkout (optional; admin reports payment per ticket)
alter table public.attendees add column if not exists booking_id uuid references public.bookings(id) on delete set null;
create index if not exists attendees_booking_id_idx on public.attendees (booking_id);

-- Checkout sessions: store cart snapshot until payment confirmed
create table if not exists public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  status text not null default 'pending', -- pending | succeeded | cancelled
  payment_method text, -- visa | instapay
  amount_total numeric not null default 0,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists checkout_sessions_user_id_idx on public.checkout_sessions (user_id, created_at desc);

-- Blocked users (email/phone) – prevents registration in any event
create table if not exists public.blocked_users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  created_at timestamptz not null default now()
);
create index if not exists blocked_users_email_idx on public.blocked_users (lower(email));
create index if not exists blocked_users_phone_idx on public.blocked_users (phone);

-- ---------------------------------------------------------------------------
-- Scanner profiles (multiple scanners + server-side immutable scan history)
-- ---------------------------------------------------------------------------

create table if not exists public.scanners (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  password_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Upgrade older DBs: allow scanners without passwords (admin approval flow).
alter table public.scanners alter column password_hash drop not null;

create index if not exists scanners_active_idx on public.scanners (active);

-- Scanner opens their link, enters name only → admin approves → device gets a session.
create table if not exists public.scanner_access_requests (
  id uuid primary key default gen_random_uuid(),
  scanner_id uuid not null references public.scanners(id) on delete cascade,
  device_id text not null,
  requested_name text not null,
  status text not null default 'pending',
  approval_token text,
  consumed_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists scanner_access_requests_pending_idx
  on public.scanner_access_requests (status, created_at desc);

create unique index if not exists scanner_access_one_pending_per_device
  on public.scanner_access_requests (scanner_id, device_id)
  where (status = 'pending');

-- One scanner profile can work from multiple devices (each device has its own device_id).
create table if not exists public.scanner_devices (
  id uuid primary key default gen_random_uuid(),
  scanner_id uuid not null references public.scanners(id) on delete cascade,
  device_id text not null,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  unique(scanner_id, device_id)
);

create index if not exists scanner_devices_scanner_id_idx on public.scanner_devices (scanner_id);

-- Staff member operating this device (entered at login; shown in admin history).
alter table public.scanner_devices add column if not exists operator_name text;

-- Server-side scan logs (so scanners can’t clear history locally).
create table if not exists public.scanner_scan_logs (
  id uuid primary key default gen_random_uuid(),
  scanner_id uuid references public.scanners(id) on delete set null,
  device_id text,
  operator_name text,
  ticket_id text not null,
  status text not null, -- success | already_used | invalid
  user_name text,
  user_email text,
  event_id uuid,
  event_name text,
  ticket_category text,
  ticket_number text,
  checkin_time timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists scanner_scan_logs_scanner_id_created_idx on public.scanner_scan_logs (scanner_id, created_at desc);
create index if not exists scanner_scan_logs_device_id_created_idx on public.scanner_scan_logs (device_id, created_at desc);

-- Upgrade: operator on each scan (who was holding the phone).
alter table public.scanner_scan_logs add column if not exists operator_name text;

-- Optional: trigger stub to call a Supabase Edge Function when a new attendee is created.
-- This lets Supabase itself send the QR email (instead of Node).
-- 1) Deploy an Edge Function called \"send-ticket-email\" that accepts the attendee record.
-- 2) Replace YOUR_FUNCTION_URL below with its URL (from the Supabase dashboard).
-- 3) Replace YOUR_SERVICE_ROLE_OR_ANON_KEY with a key that function expects in the apikey header.
--
-- Note: comment out or adjust if you don't want Supabase-driven email.
--
-- create or replace function public.notify_send_ticket_email()
-- returns trigger
-- language plpgsql
-- as $$
-- begin
--   perform
--     supabase_functions.http_request(
--       method  => 'POST',
--       url     => 'https://YOUR_PROJECT_ID.functions.supabase.co/send-ticket-email',
--       headers => jsonb_build_object(
--         'Content-Type', 'application/json',
--         'apikey', 'YOUR_SERVICE_ROLE_OR_ANON_KEY'
--       ),
--       body    => jsonb_build_object('record', row_to_json(NEW))
--     );
--   return NEW;
-- end;
-- $$;
--
-- drop trigger if exists trg_attendees_send_ticket_email on public.attendees;
-- create trigger trg_attendees_send_ticket_email
-- after insert on public.attendees
-- for each row execute procedure public.notify_send_ticket_email();

-- Key/value style settings (promo codes for checkout; writable on Vercel via Supabase)
create table if not exists public.app_settings (
  id text primary key default 'global',
  promo_codes jsonb not null default '[]'::jsonb,
  event_rules jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id, promo_codes)
values ('global', '[]'::jsonb)
on conflict (id) do nothing;

-- Tables are ready. Your server uses SUPABASE_SERVICE_ROLE_KEY and has full access.
