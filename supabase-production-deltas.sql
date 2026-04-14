-- =============================================================================
-- BLOCK — production deltas (idempotent)
-- =============================================================================
-- Run in: Supabase → SQL Editor → New query → paste → Run
--
-- Safe to run more than once. Does not drop data.
-- New project? Prefer running the full `supabase-schema.sql` once, then you can
-- still run this file (everything is IF NOT EXISTS / additive).
-- =============================================================================

-- UUID defaults on tables
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 2026-04-13: bookings — faster filters by user + payment/status
-- -----------------------------------------------------------------------------
create index if not exists bookings_user_status_idx
  on public.bookings (user_id, status);

-- -----------------------------------------------------------------------------
-- Catch-up: app_users (email signup, Google OAuth profile, forgot-password)
-- -----------------------------------------------------------------------------
alter table public.app_users add column if not exists phone text;
alter table public.app_users add column if not exists birthdate date;
alter table public.app_users add column if not exists gender text;
alter table public.app_users add column if not exists password_reset_token_hash text;
alter table public.app_users add column if not exists password_reset_expires_at timestamptz;
alter table public.app_users add column if not exists profile_picture_url text;
alter table public.app_users add column if not exists updated_at timestamptz not null default now();

create index if not exists app_users_password_reset_token_idx
  on public.app_users (password_reset_token_hash)
  where password_reset_token_hash is not null;

-- -----------------------------------------------------------------------------
-- Catch-up: events (admin editor + pricing)
-- -----------------------------------------------------------------------------
-- List/cards vs detail hero: optional separate artwork URLs
alter table public.events add column if not exists image_card text;
alter table public.events add column if not exists image_detail text;

alter table public.events add column if not exists available_tickets integer;
alter table public.events add column if not exists price numeric not null default 0;
alter table public.events add column if not exists sort_order integer;
alter table public.events add column if not exists extra jsonb default '{}'::jsonb;

create index if not exists events_sort_order_idx
  on public.events (sort_order nulls last, created_at desc);

-- -----------------------------------------------------------------------------
-- Catch-up: scanners / devices (approval flow, optional password)
-- -----------------------------------------------------------------------------
alter table public.scanners alter column password_hash drop not null;

alter table public.scanner_devices add column if not exists operator_name text;

alter table public.scanner_scan_logs add column if not exists operator_name text;

-- -----------------------------------------------------------------------------
-- Profile photos (optional): Supabase Dashboard → Storage → New bucket
--   Name: avatars (or set SUPABASE_AVATARS_BUCKET in .env)
--   Public bucket: ON (so getPublicUrl works for avatars)
-- If the bucket is missing, the server falls back to local files under
-- public/uploads/avatars/ (fine for VPS; not for read-only serverless).
-- -----------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Catch-up: attendees (admin list + scanner metadata)
-- Older projects may lack columns that newer code references.
-- ---------------------------------------------------------------------------
alter table public.attendees add column if not exists ticket_category text;
alter table public.attendees add column if not exists ticket_number text;
alter table public.attendees add column if not exists scanned_by_name text;
alter table public.attendees add column if not exists scanned_by_phone text;

alter table public.attendees add column if not exists booking_id uuid references public.bookings(id) on delete set null;
create index if not exists attendees_booking_id_idx on public.attendees (booking_id);

-- -----------------------------------------------------------------------------
-- 2026-04-13: allow multiple bookings per user for the same event
-- -----------------------------------------------------------------------------
alter table public.bookings drop constraint if exists bookings_user_id_event_id_key;
do $$
declare
  conname text;
begin
  select c.conname into conname
  from pg_constraint c
  join pg_class t on c.conrelid = t.oid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'bookings'
    and c.contype = 'u'
    and coalesce(pg_get_constraintdef(c.oid), '') like '%user_id%'
    and coalesce(pg_get_constraintdef(c.oid), '') like '%event_id%'
  limit 1;
  if conname is not null then
    execute format('alter table public.bookings drop constraint %I', conname);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- InstaPay: store sender phone for manual admin confirmation
-- -----------------------------------------------------------------------------
alter table public.bookings add column if not exists instapay_sender_phone text;

-- =============================================================================
-- Done. Verify: no errors in the SQL Editor output.
-- =============================================================================
