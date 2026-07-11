# Tenant Admin Portal — Build Status

**Based on:** `tenant-admin-portal-plan.md`
**Current build:** `index.html` (M1–M3 complete)
**Legend:** ✅ done · 🟡 partially done · ⬜ not started

---

## 2. Data Model

- ✅ **Locations** — `id, name, address, notes` (`unitCount` computed live, not stored)
- ✅ **Units** — `id, locationId, unitLabel, monthlyRent, status, notes` + `dueDay` (added — needed for overdue calc)
- ✅ **Tenants** — `id, unitId, fullName, contactNumber, moveInDate, moveOutDate, depositAmount, notes` + `documents` (ID photo + signed contract, Firebase Storage — replaces the old `idPhoto` placeholder field)
- ✅ **Payments** — `id, tenantId, unitId, amountPaid, dueDate, datePaid, method, coveredPeriod, status, notes`
- ✅ `updatedAt` timestamp added to every location/unit/tenant/payment write — required for last-write-wins cloud sync, same field Pautang Pro uses
- ⬜ **Admin Users** — not built (single-admin for v1, confirmed)

**Design decisions — all locked in:**
- ✅ Single admin only for v1
- ✅ Rent cycle: fixed monthly due date **per unit** (`unit.dueDay`)
- ✅ Partial payments allowed
- ✅ Deposit tracked as a single field on the tenant record (not a ledger line)

---

## 3. Feature Checklist

### Core (v1 — must have)
- ✅ Location switcher / dashboard
- ✅ Unit list per location with occupied/vacant status
- ✅ Add/edit/remove unit
- ✅ Add/edit tenant, assign to unit
- ✅ Move-out flow (marks unit vacant, archives tenant record)
- ✅ Log a payment
- ✅ Payment history per tenant/unit
- ✅ Dashboard summary (total units, occupied vs vacant, collected vs expected, overdue count)
- ✅ Overdue/due-soon list across all 3 locations
- ✅ Search tenant by name across all locations

### Nice-to-have (v1.5)
- ⬜ Simple receipt generator
- ⬜ Export to Excel/PDF
- ⬜ Due-date reminders (local notifications)
- 🟡 Photo attachment for tenant ID/contract — built (Documents block on tenant detail, upload/replace/remove, Firebase Storage), needs Storage enabled + `storage.rules` published in console before it actually works end to end
- ⬜ Dark/light theme toggle

### Later (v2+)
- ⬜ Multi-admin with role-based access per location
- ⬜ Tenant-facing view (read-only balance check)
- ⬜ Maintenance/repair request log per unit
- ⬜ Utility bill splitting per unit

---

## 4. Architecture

- ✅ Single self-contained `index.html`
- ✅ IndexedDB as local-first source of truth
- ✅ Firebase Auth — full email/password sign-in/sign-up/sign-out UI wired (ported from Pautang Pro), real project config in place, Authentication enabled in console
- ✅ Firestore sync — full last-write-wins sync engine wired (`queueRecordSync` on every write to locations/units/tenants/payments, `pullAndMergeCollection` + `runFullCloudSync` on sign-in / reconnect / 3-min interval), Firestore enabled and security rules published — code + console both done, real-world testing still open (see M4)
- ✅ `manifest.json` + service worker — full offline + versioning strategy: versioned `CACHE_NAME` (bump `CACHE_VERSION` in `sw.js` on every shell change), cache-first app shell with network fallback, offline-navigation fallback to cached `index.html`, old-cache cleanup on activate, and an in-app "Refresh" banner that only reloads when the person taps it (no silent version swaps under an open session)
- ✅ Mobile-first CSS (~390px design width, bottom nav, large tap targets)

---

## 5. Firebase Setup Checklist

- ✅ Sync code written and wired into the app (Auth UI + Firestore last-write-wins engine, ported from Pautang Pro)
- ✅ Create Firebase project — `upapro-e5763`
- ✅ Enable Firestore (production mode + security rules)
- ✅ Enable Authentication (email/password)
- ✅ Publish Firestore security rules (`users/{uid}/{store}/{docId}`, owner-only read/write)
- ✅ Drop the project's `firebaseConfig` values into `index.html` — done, `firebaseEnabled` is now `true`
- 🟡 Enable Firebase Storage (for tenant ID photos + signed contracts) — code wired in `index.html`, `storage.rules` drafted, needs to be enabled and rules published in console
- ⬜ Set up Firebase Hosting
- ⬜ Connect custom domain (optional)
- ⬜ Set up Firestore indexes
- ⬜ Decide backup strategy — **partially covered**: JSON export/import is already built and works today, independent of Firestore

---

## 6. Mobile-First Build Checklist

- ✅ Bottom tab nav: Dashboard / Locations / Overdue / Settings
- ✅ Modal sheets (not full page nav) for add/edit
- ✅ Numeric keypad input (`inputmode="decimal"`) for amounts
- ⬜ Tested on actual Android Chrome
- ✅ `viewport-fit=cover` + safe-area padding
- ⬜ Install-to-homescreen flow tested (needs `https://` hosting, not `file://`)

---

## 7. Play Store Path (later phase)

- ⬜ PWA stable on Firebase Hosting
- ⬜ TWA/Android package via PWABuilder
- ⬜ Pricing model decided
- ⬜ App icons, screenshots, feature graphic, description (placeholder icons only exist right now)
- ⬜ Privacy policy page
- ⬜ Internal testing track

---

## 8. Milestones

- ✅ **M1 — Data layer:** IndexedDB schema + CRUD for locations/units/tenants/payments
- ✅ **M2 — Core screens:** Dashboard, location drill-down, unit list, tenant add/edit, payment logging
- ✅ **M3 — Overdue/reporting view:** cross-location "who hasn't paid" list
- 🟡 **M4 — Firebase wiring:** Auth + Firestore sync code fully wired, project created, `firebaseConfig` live, Firestore + Authentication enabled, security rules published — only airplane-mode-then-reconnect testing (does a real sign-in actually push/pull data end to end?) is left before this is fully done
- 🟡 **M5 — Mobile polish + PWA install:** manifest, full offline/versioning service worker, and mobile CSS all in place; only real-device testing (Android Chrome, install-to-homescreen over `https://`) is still open
- ⬜ **M6 — Play Store packaging:** TWA build, store listing, privacy policy, submit for review

---

## Notes

- **Tenant documents via Firebase Storage (this session):** added a "Documents" section to the tenant detail screen with two slots — ID photo and Signed contract. Add/Replace/Remove all wired to Firebase Storage (`users/{uid}/tenants/{tenantId}/{slot}-{timestamp}.ext`), with the download URL + storage path saved on the tenant record's new `documents` field so it rides along through the existing Firestore sync. 15MB upload cap enforced both client-side and in `storage.rules`. Requires being signed in (Settings → Cloud sync) — there's no local-only fallback for this one, since the whole point is an off-device copy. **Needs Firebase Storage enabled + `storage.rules` published** in console before uploads will actually succeed.
- **PWA offline + versioning (this session):** rewrote `sw.js` with a versioned `CACHE_NAME` (bump `CACHE_VERSION` whenever the shell changes), cache-first app shell, offline navigation fallback, and old-cache cleanup on activate. `manifest.json` filled out properly (icons, standalone display, theme colors, categories). `index.html` now listens for `updatefound`/`controllerchange` and shows a dismissable "Refresh" banner instead of silently reloading a session mid-use. **Needs real `icon-192.png` and `icon-512.png` files** dropped next to `index.html` — the manifest and SW both reference them but no icon files exist yet (see section 7).
- **Cloud sync ported from Pautang Pro (this session):** the full Auth + Firestore module — sign-in/sign-up/sign-out sheet, `queueRecordSync` fire-and-forget push on every write, `pullAndMergeCollection` + `runFullCloudSync` last-write-wins merge on sign-in, `online` event, and a 3-minute auto-sync timer — is now in `index.html`, gated behind `firebaseEnabled`. Same collection shape too: `users/{uid}/{store}/{id}`.
- **Bug fix — deleted locations/units resurrecting after sync:** deleting only removed the record locally, so the next sync pulled the still-present cloud copy right back. Fixed with soft-delete tombstones (`deleted: true, updatedAt`) — `refreshCache()` now filters tombstones out of everything the UI reads, while the raw sync/merge logic still sees them so the delete itself propagates and won't bounce back. Note: any locations/units deleted *before* this fix may still be sitting in Firestore without a tombstone — deleting them again once will properly tombstone and clear them for good.
- Still needed before this does anything: real sign-in testing end-to-end (create an account in the app, confirm data appears in the Firestore console, test airplane-mode-then-reconnect). All the setup — project, config, Firestore, Auth, rules — is done.
- Reused patterns from Pautang Pro / Biryani King POS: local-first + last-write-wins sync (now wired), JSON backup/restore (done, and restored records now also push to the cloud if signed in), PWA install-prompt gotcha (`file://` won't trigger it — documented in README).
- The Overdue view is fully functional now and is the one worth testing first, since it drives the daily workflow.
