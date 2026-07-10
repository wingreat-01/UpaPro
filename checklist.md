# Tenant Admin Portal — Build Status

**Based on:** `tenant-admin-portal-plan.md`
**Current build:** `index.html` (M1–M3 complete)
**Legend:** `[x]` done · `[~]` partially done · `[ ]` not started

---

## 2. Data Model

- [x] **Locations** — `id, name, address, notes` (`unitCount` computed live, not stored)
- [x] **Units** — `id, locationId, unitLabel, monthlyRent, status, notes` + `dueDay` (added — needed for overdue calc)
- [~] **Tenants** — `id, unitId, fullName, contactNumber, moveInDate, moveOutDate, depositAmount, notes` (all done except `idPhoto`)
- [x] **Payments** — `id, tenantId, unitId, amountPaid, dueDate, datePaid, method, coveredPeriod, status, notes`
- [ ] **Admin Users** — not built (single-admin for v1, confirmed)

**Design decisions — all locked in:**
- [x] Single admin only for v1
- [x] Rent cycle: fixed monthly due date **per unit** (`unit.dueDay`)
- [x] Partial payments allowed
- [x] Deposit tracked as a single field on the tenant record (not a ledger line)

---

## 3. Feature Checklist

### Core (v1 — must have)
- [x] Location switcher / dashboard
- [x] Unit list per location with occupied/vacant status
- [x] Add/edit/remove unit
- [x] Add/edit tenant, assign to unit
- [x] Move-out flow (marks unit vacant, archives tenant record)
- [x] Log a payment
- [x] Payment history per tenant/unit
- [x] Dashboard summary (total units, occupied vs vacant, collected vs expected, overdue count)
- [x] Overdue/due-soon list across all 3 locations
- [x] Search tenant by name across all locations

### Nice-to-have (v1.5)
- [ ] Simple receipt generator
- [ ] Export to Excel/PDF
- [ ] Due-date reminders (local notifications)
- [ ] Photo attachment for tenant ID/contract
- [ ] Dark/light theme toggle

### Later (v2+)
- [ ] Multi-admin with role-based access per location
- [ ] Tenant-facing view (read-only balance check)
- [ ] Maintenance/repair request log per unit
- [ ] Utility bill splitting per unit

---

## 4. Architecture

- [x] Single self-contained `index.html`
- [x] IndexedDB as local-first source of truth
- [ ] Firebase Auth — hook point only (`firebaseConfig` in script), not wired
- [ ] Firestore sync — hook point only, not wired
- [~] `manifest.json` + service worker — present, but shell-caching stub only (not the full offline/versioning strategy)
- [x] Mobile-first CSS (~390px design width, bottom nav, large tap targets)

---

## 5. Firebase Setup Checklist

- [ ] Create Firebase project
- [ ] Enable Firestore (production mode + security rules)
- [ ] Enable Authentication
- [ ] Write Firestore security rules
- [ ] Set up Firebase Hosting
- [ ] Connect custom domain (optional)
- [ ] Set up Firestore indexes
- [ ] Decide backup strategy — **partially covered**: JSON export/import is already built and works today, independent of Firestore

---

## 6. Mobile-First Build Checklist

- [x] Bottom tab nav: Dashboard / Locations / Overdue / Settings
- [x] Modal sheets (not full page nav) for add/edit
- [x] Numeric keypad input (`inputmode="decimal"`) for amounts
- [ ] Tested on actual Android Chrome
- [x] `viewport-fit=cover` + safe-area padding
- [ ] Install-to-homescreen flow tested (needs `https://` hosting, not `file://`)

---

## 7. Play Store Path (later phase)

- [ ] PWA stable on Firebase Hosting
- [ ] TWA/Android package via PWABuilder
- [ ] Pricing model decided
- [ ] App icons, screenshots, feature graphic, description (placeholder icons only exist right now)
- [ ] Privacy policy page
- [ ] Internal testing track

---

## 8. Milestones

- [x] **M1 — Data layer:** IndexedDB schema + CRUD for locations/units/tenants/payments
- [x] **M2 — Core screens:** Dashboard, location drill-down, unit list, tenant add/edit, payment logging
- [x] **M3 — Overdue/reporting view:** cross-location "who hasn't paid" list
- [ ] **M4 — Firebase wiring:** Auth + Firestore sync, airplane-mode-then-reconnect testing
- [~] **M5 — Mobile polish + PWA install:** manifest/SW/mobile CSS in place; real-device testing and full offline strategy still open
- [ ] **M6 — Play Store packaging:** TWA build, store listing, privacy policy, submit for review

---

## Notes

- Reused patterns from Pautang Pro / Biryani King POS: local-first + last-write-wins sync (hook ready, not yet wired), JSON backup/restore (done), PWA install-prompt gotcha (`file://` won't trigger it — documented in README).
- The Overdue view is fully functional now and is the one worth testing first, since it drives the daily workflow.
