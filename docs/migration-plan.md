# BLOCK Web Platform Migration Plan

## Goal

Build a long-term, high-performance platform for Egypt while keeping the current production app stable.

This plan is designed to avoid risky "big bang" rewrites.

## Current State

- Backend + API: `server.js` (Express)
- Frontend: static pages in `public/*.html` with shared `site-chrome.css/js`
- Data/Auth: Supabase

## Strategy

Use an incremental migration:

1. Stabilize the current system (business-critical reliability first)
2. Build a new Next.js frontend page-by-page
3. Keep existing APIs during migration, refactor backend gradually
4. Harden production for scale and quality

---

## Phase 1 - Stabilize Current App (Now)

### Priority outcomes

- No booking/cap regressions
- No checkout dead ends
- Consistent ticket visibility in Profile/My Tickets
- Admin save/edit reliability
- Arabic/English usability parity

### Work items

- Capacity enforcement + deduction validation by category
- Booking popup and proceed flow hardening
- Admin category table UX and quantity clarity
- My Tickets pagination and payment history pagination
- Header/footer and language behavior consistency across pages
- Critical endpoint smoke tests and manual regression pass

### Exit criteria

- All critical regression checklist items pass
- No blocker bug in booking, payment, admin event edit, or ticket retrieval flows

---

## Phase 2 - New Next.js Frontend (Page-by-Page)

### Target stack

- Next.js (App Router)
- React + TypeScript
- Tailwind CSS
- i18n from day one (Arabic + English)

### Route migration order

1. Home
2. Events list
3. Event details / booking popup
4. Checkout and payment status
5. My Tickets
6. Profile
7. Auth pages
8. Admin UI (last)

### Rules

- Keep existing Express endpoints as backend contract
- Do not break current pages while new pages are introduced
- Roll out using safe route switches/feature flags

### Exit criteria

- New frontend serves all public critical routes
- UX and translation parity with current app
- API compatibility preserved

---

## Phase 3 - API/Service Refactor (Safe)

### Objectives

- Reduce `server.js` monolith complexity
- Improve maintainability and testability

### Work items

- Split into modules:
  - auth
  - events
  - bookings/checkout
  - admin
  - tickets/qr
- Normalize error handling and response shapes
- Add service layer for Supabase queries
- Add route-level validation and stronger typing contracts

### Exit criteria

- Critical routes moved from monolith sections to modular services
- No behavior regressions in production

---

## Phase 4 - Production Hardening

### Performance

- Response caching policy per endpoint
- Image optimization pipeline (upload resize + modern formats)
- CDN/cache headers review
- Query/index tuning for high-frequency reads

### SEO

- Structured data for events
- Meta and Open Graph completeness
- Canonicals and crawl hygiene

### Accessibility

- Keyboard navigation, focus states, modal trapping
- Color contrast and readable interaction states
- ARIA validation on dynamic components

### Reliability/Observability

- Error monitoring + alerting
- Request logs and key business event logs
- Basic uptime and API health checks

### Security

- Supabase RLS review and tightening
- Secret handling audit
- Auth/session hardening checks

### Exit criteria

- Meets performance and reliability targets
- No critical security gaps in auth/data flows

---

## Delivery Rhythm

- Weekly: bug triage + progress review
- Bi-weekly: release train (small safe batches)
- Every phase: explicit exit checklist before moving on

## Immediate Next Actions

1. Execute Phase 1 regression checklist and fix any blockers
2. Scaffold Next.js project structure (without route cutover)
3. Migrate Home route as first Phase 2 page
