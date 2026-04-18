# Phase 1 Regression Checklist

Use this checklist before and after each Phase 1 change.

## Booking and Capacity

- [ ] Event with category cap enforces limit at booking popup
- [ ] Remaining category seats are reflected correctly after paid booking
- [ ] Sold-out categories cannot be incremented in booking popup
- [ ] Checkout rejects over-cap requests server-side

## Checkout and Payment

- [ ] Proceed from booking modal works when authenticated
- [ ] Proceed redirects to auth when not authenticated
- [ ] Cart add/update per category works for multiple selections
- [ ] Payment confirmation finalizes bookings and ticket generation

## Tickets Visibility

- [ ] Profile booked card reflects ticket quantity correctly
- [ ] My Tickets list shows all issued tickets
- [ ] QR modal opens correctly for selected ticket
- [ ] Payment history loads and paginates correctly

## Admin Reliability

- [ ] Admin event edit saves successfully
- [ ] Category table inputs (name/price/cap/sold out/remove) work correctly
- [ ] Add/remove category updates payload correctly
- [ ] Event list reload after save shows latest values

## Language and Shared UI

- [ ] Header layout remains centered in EN and AR
- [ ] AR mode swaps top utility positions correctly
- [ ] Footer style is consistent across Home/My Tickets
- [ ] Shared buttons and contrast remain readable in light/dark scroll states

## Pagination

- [ ] My Tickets paginates at 10 rows per page
- [ ] Payment history paginates at 10 rows per page
- [ ] Pagination controls update correctly after filtering

## Smoke Endpoints

- [ ] `GET /api/booking-event/:id`
- [ ] `POST /api/cart/add-ticket`
- [ ] `POST /api/checkout/start`
- [ ] `POST /api/checkout/confirm`
- [ ] `GET /api/auth/me`
- [ ] `GET /api/auth/my-entry-tickets`
- [ ] `GET /api/auth/payment-history`
- [ ] `GET /api/admin/events`

## Sign-off

- Date:
- Tested by:
- Notes:
