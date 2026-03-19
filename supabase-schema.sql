-- Run this in Supabase: SQL Editor → New query → paste → Run
-- Project: wrgpjagqfygyibhmtjwu (or use your project URL)
create extension if not exists pgcrypto;
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

-- Bookings: prevent duplicate booking per user+event
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  status text not null default 'confirmed', -- confirmed | cancelled | refunded (future)
  payment_method text, -- visa | instapay | free
  price_paid numeric not null default 0,
  ticket_selections jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, event_id)
);
create index if not exists bookings_user_id_idx on public.bookings (user_id, created_at desc);
create index if not exists bookings_event_id_idx on public.bookings (event_id, created_at desc);

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
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists scanners_active_idx on public.scanners (active);

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

-- Server-side scan logs (so scanners can’t clear history locally).
create table if not exists public.scanner_scan_logs (
  id uuid primary key default gen_random_uuid(),
  scanner_id uuid references public.scanners(id) on delete set null,
  device_id text,
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

-- Tables are ready. Your server uses SUPABASE_SERVICE_ROLE_KEY and has full access.
