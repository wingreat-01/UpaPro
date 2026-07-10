# Tenant Admin Portal — Project Plan

**Type:** Single-file HTML app → Firebase Hosting → PWA → Play Store (TWA)
**Scope:** 3 paupahan (boarding house) locations, ~6-8 units each (18-24 units total)
**Priority:** Mobile-first (this will be the primary interface, not a desktop-adapted view)

---

## 1. Overview

An admin portal for a landlord/property manager to track tenants, units, and rent
payments across multiple paupahan locations from a phone. Same architecture pattern
as Pautang Pro: local-first storage (IndexedDB) with Firebase Auth + Firestore sync,
built as one self-contained HTML file first, then wrapped into a TWA for Play Store.

**Out of scope for v1:** tenant-facing login/portal, online rent payment collection,
SMS/email notifications (can be phase 2+).

---

## 2. Data Model

- [ ] **Locations** — `id, name, address, unitCount, notes`
- [ ] **Units** — `id, locationId, unitLabel (e.g. "Room 3"), monthlyRent, status (occupied/vacant/maintenance), notes`
- [ ] **Tenants** — `id, unitId, fullName, contactNumber, moveInDate, moveOutDate, depositAmount, idPhoto (optional), notes`
- [ ] **Payments** — `id, tenantId, unitId, amountPaid, dueDate, datePaid, method (cash/gcash/bank), coveredPeriod (e.g. "Jul 2026"), status (paid/partial/late), notes`
- [ ] **Admin Users** — `id, name, role (owner/caretaker), locationsAssigned[]` *(if more than one person will manage this)*

**Design decisions to lock in before coding:**
- [ ] Single admin only for v1, or multi-user with per-location access?
- [ ] Rent cycle: fixed monthly due date per unit, or per-tenant custom due date?
- [ ] Partial payments allowed, or full-amount-only?
- [ ] Deposit/advance handling — tracked as a ledger line or a separate field?

---

## 3. Feature Checklist

### Core (v1 — must have)
- [ ] Location switcher / dashboard (3 paupahan, tap to drill into units)
- [ ] Unit list per location with occupied/vacant status at a glance
- [ ] Add/edit/remove unit (rent amount, label, status)
- [ ] Add/edit tenant, assign to unit
- [ ] Move-out flow (marks unit vacant, archives tenant record)
- [ ] Log a payment (amount, date, method, period covered)
- [ ] Payment history per tenant/unit
- [ ] Dashboard summary: total units, occupied vs vacant, this month's collected vs expected, overdue count
- [ ] Overdue/due-soon list across all 3 locations (the "who hasn't paid" view — this is the most-used screen, prioritize it)
- [ ] Search tenant by name across all locations

### Nice-to-have (v1.5 — if time allows)
- [ ] Simple receipt generator (share as image/PDF text after logging payment)
- [ ] Export to Excel/PDF (same pattern as Pautang Pro exports)
- [ ] Due-date reminders (local notifications, same pattern as Pautang Pro)
- [ ] Photo attachment for tenant ID/contract
- [ ] Dark/light theme toggle

### Later (v2+)
- [ ] Multi-admin with role-based access per location
- [ ] Tenant-facing view (read-only balance check)
- [ ] Maintenance/repair request log per unit
- [ ] Utility bill splitting (water/electric) per unit

---

## 4. Architecture

- [ ] Single self-contained `index.html` (same pattern as Pautang Pro / Biryani King POS) — no build step, easy to iterate and host directly
- [ ] IndexedDB as local-first source of truth (offline-first, works with no signal at the boarding house)
- [ ] Firebase Auth (email/password or phone) for the admin login
- [ ] Firestore for cloud sync — same last-write-wins merge strategy as Pautang Pro
- [ ] `manifest.json` + service worker for installable PWA from day one (not bolted on later)
- [ ] Mobile-first CSS: design at ~375-414px width first, bottom nav bar (not sidebar), large tap targets, thumb-reachable primary actions

---

## 5. Firebase Setup Checklist

- [ ] Create Firebase project
- [ ] Enable Firestore (production mode + security rules, not test mode)
- [ ] Enable Authentication (decide: email/password vs phone OTP)
- [ ] Write Firestore security rules (admin-only read/write, scoped correctly if multi-user later)
- [ ] Set up Firebase Hosting
- [ ] Connect custom domain (optional) or use default `*.web.app` / `*.firebaseapp.com`
- [ ] Set up Firestore indexes for queries you'll actually run (e.g. payments by dueDate + status)
- [ ] Decide backup strategy (Firestore export, or reuse the JSON backup/restore pattern from Pautang Pro)

---

## 6. Mobile-First Build Checklist

- [ ] Bottom tab nav: Dashboard / Locations / Overdue / Settings (mirror Pautang Pro's nav pattern)
- [ ] All forms usable one-handed — modal sheets, not full page navigations, for add/edit
- [ ] Numeric keypad input for amounts (`inputmode="decimal"`)
- [ ] Test on actual Android Chrome, not just desktop resize — PWA install prompt behavior, viewport units, and touch target sizing differ
- [ ] `viewport-fit=cover` + safe-area padding if targeting phones with notches/gesture bars
- [ ] Test install-to-homescreen flow (learned from Biryani King POS: `beforeinstallprompt` breaks on `file://`, needs to be served over `https://` — Firebase Hosting solves this automatically)

---

## 7. Play Store Path (later phase)

- [ ] Get the PWA fully functional and stable on Firebase Hosting first — don't wrap into TWA until core features are solid
- [ ] Use PWABuilder (same tool as Pautang Pro) to generate the TWA/Android package
- [ ] Decide pricing model early: free, one-time purchase, or subscription (Pautang Pro's model can likely be reused)
- [ ] App icons, screenshots (mobile + optionally tablet), feature graphic, short/full description
- [ ] Privacy policy page (required by Play Store — needed even for a simple admin tool, since it touches tenant personal data)
- [ ] Internal testing track before public release

---

## 8. Milestones

- [ ] **M1 — Data layer:** IndexedDB schema + CRUD for locations/units/tenants/payments working locally, no UI polish
- [ ] **M2 — Core screens:** Dashboard, location drill-down, unit list, tenant add/edit, payment logging
- [ ] **M3 — Overdue/reporting view:** the "who hasn't paid" cross-location list — this is the daily-use screen
- [ ] **M4 — Firebase wiring:** Auth + Firestore sync, tested with airplane-mode-then-reconnect
- [ ] **M5 — Mobile polish + PWA install:** manifest, service worker, real-device testing
- [ ] **M6 — Play Store packaging:** TWA build, store listing, privacy policy, submit for review

---

## Notes

- Reuse what already works from Pautang Pro and Biryani King POS: local-first + last-write-wins sync, PWA install-prompt fixes, JSON backup/restore pattern, Excel/PDF export approach. No need to re-solve those problems.
- Keep the "Overdue" cross-location view as the single most important screen — that's the one that gets opened every day.
