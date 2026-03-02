-- Run this in Supabase: SQL Editor → New query → paste → Run
-- Project: wrgpjagqfygyibhmtjwu (or use your project URL)

-- Attendees table (one row per registration; unique ticket_id per person)
create table if not exists public.attendees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  ticket_id text not null unique,
  event_id text,
  event_name text,
  attended boolean not null default false,
  checkin_time timestamptz,
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
  sort_order integer,
  available_tickets integer,  -- max registrations (admin only, not shown to users)
  created_at timestamptz not null default now()
);

-- Add column if upgrading existing DB (run separately if needed):
-- alter table public.events add column if not exists available_tickets integer;

create index if not exists events_sort_order_idx on public.events (sort_order nulls last, created_at desc);

-- Blocked users (email/phone) – prevents registration in any event
create table if not exists public.blocked_users (
  id uuid primary key default gen_random_uuid(),
  email text,
  phone text,
  created_at timestamptz not null default now()
);
create index if not exists blocked_users_email_idx on public.blocked_users (lower(email));
create index if not exists blocked_users_phone_idx on public.blocked_users (phone);

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
