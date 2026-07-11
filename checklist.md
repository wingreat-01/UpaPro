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
- ✅ Firestore sync — full last-write-wins sync engine wired (`queueRecordSync` on every write to locations/units/tenants/payments, `pullAndMergeCollection` + `runFullCloudSync` on sign-in / reconnect / 3-min interval), backed by a durable `_syncOutbox` retry queue so interrupted writes (closed tab, dropped connection) aren't silently lost, Firestore enabled and security rules published — code + console both done, real-world testing still open (see M4)
- ✅ `manifest.json` + service worker — full offline + versioning strategy: versioned `CACHE_NAME` (bump `CACHE_VERSION` in `sw.js` on every shell change), cache-first app shell with network fallback, offline-navigation fallback to cached `index.html`, old-cache cleanup on activate, and an in-app "Refresh" banner that only reloads when the person taps it (no silent version swaps under an open session)
- ✅ Mobile-first CSS (~390px design width, bottom nav, large tap targets)

---

## 5. Firebase Setup Checklist

- ✅ Sync code written and wired into the app (Auth UI + Firestore last-write-wins engine, ported from Pautang Pro)
- ✅ Create Firebase project — `upapro-e5763`
- ✅ Enable Firestore (production mode + security rules)
- ✅ Enable Authentication (email/password)
- ✅ Publish Firestore security rules (`users/{uid}/{store}/{docId}`, owner-only read/write)
- ⬜ Publish tenant portal Firestore security rules (`invites/{code}`, `portalAccounts/{uid}`, scoped cross-account reads) — drafted this session as `firestore.rules`, needs review + publishing in console before the tenant portal can work reliably
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

- **Bug fix — back button closes the whole sheet instead of just the keyboard, only in the password field (this session):** the sheet-close-on-Android-back trick works by pushing a history entry when a sheet opens and closing the sheet on `popstate`. For a plain text/email field, Android normally eats the back press itself just to lower the keyboard, so our `popstate` handler never even fires. A `type="password"` field can show its own autofill/suggestion overlay, and that overlay sometimes lets the same back press fall through to the page as real navigation — so back-in-password was popping the whole cloud-sync sheet instead of just dismissing the keyboard, while back-in-email behaved correctly. **Fix:** the `popstate` handler now checks whether a field inside the sheet still has focus; if so, it just blurs that field (closing the keyboard) and re-pushes the history entry, leaving the sheet open — only a back press with nothing focused actually closes the sheet. This is in the shared sheet code, so it applies anywhere a sheet has a text input, not just cloud sync.
  - **Still to verify:** on an actual Android device/Chrome, tap into the password field, press back once (keyboard should close, sheet stays open), then press back again (sheet should close).

- **UX tweak — cloud sync sheet auto-closes after sign-in/sign-up (this session):** the sheet used to stay open and just refresh its own "signed in" view after a successful sign-in or account creation. It now calls `closeSheet()` right after, same as the sign-out button already did — one less tap to get back to the app.

- **Gap found — tenant portal Firestore security rules were never actually written (this session):** the code has two comments promising the required rules are "written out in full at the very end of this file" — they aren't; the end of the file has no rules text at all. Section 5 only confirms the *base* admin rule (`users/{uid}/{store}/{docId}`, owner-only) was published, which doesn't cover what the tenant portal needs: `invites/{code}`, `portalAccounts/{uid}`, and narrow cross-account reads of the admin's own tenant/unit/payment docs. Without these, portal redemption and daily use can fail for reasons unrelated to the client-side race-condition fixes above. **Drafted `firestore.rules`** (separate file, not part of `index.html`) covering exactly the access pattern in the "DATA IT TOUCHES" comment: invite create/get/one-time-use-update, one-time portalAccounts link creation (verified server-side against the invite's `used`/`usedByUid`), and scoped tenant/unit/payment/pendingPayment access for a linked tenant. **Needs review and publishing in the Firebase console** — this is a draft to check against the actual current rules before replacing anything live.
- **Hardening — regenerating an invite code now voids the old one (this session):** previously the old `invites/{code}` doc was left behind, still valid and unused, even after generating a replacement — an old code (old screenshot, message thread) could still be redeemed later. `generatePortalInvite()` now marks the previous pending invite `used: true` (with a `voidedAt` timestamp) before creating the new one.
- **Bug fix — invite code creation could fail silently if offline (this session):** the code-collision check loop sat outside the `try/catch` in `generatePortalInvite()`, so a network error during it threw uncaught with no toast/feedback. The whole function is now wrapped, so a failure here always surfaces "Could not create invite — check your connection."

- **Bug fix — "This account isn't linked to a tenant yet" still appearing during invite redemption (this session, follow-up):** the previous fix (reordering delete-before-flag-drop) closed one gap, but the deeper issue remained: the `portalRedeeming` boolean only guards against auth events that happen to arrive *while it's true* — it can't guarantee Firebase actually delivers the sign-up (or delete) auth event before that flag flips back, no matter how the cleanup code is ordered. That timing simply isn't something the app controls. **Fix:** `portalRedeemInvite()` now fully detaches the `onAuthStateChanged` listener (via its unsubscribe function, `portalAuthUnsub`) for the entire redemption attempt, instead of just flagging it to be ignored. With nothing listening, there's no event left to race — the listener is only reattached once the account is in a known-good (redeemed) or known-cleaned-up (deleted) state, and it fires immediately with whatever the real, current status is at that point.
  - **Still to verify:** redeem a valid, unused invite code end-to-end and confirm it lands on the tenant dashboard without the toast; also re-test a bad/reused code to confirm the specific invite error still shows correctly.

- **Bug fix — invite redemption shows "This account isn't linked to a tenant yet" instead of the real error (this session):** happened whenever a tenant entered a bad invite code (typo, already-used, expired). `portalRedeemInvite()` creates the throwaway Firebase Auth account *before* validating the code, guarded by a `portalRedeeming` flag so the auth-state listener ignores it mid-flight. On a bad code, the cleanup path was un-guarding (`portalRedeeming = false`) *before* deleting that throwaway account — and `newUser.delete()` itself fires an auth-state change, which then hit the now-unguarded listener, found no linked tenant record (there never was one), signed the account out, showed the generic "isn't linked" toast, and bounced back to the login screen — wiping out the signup form (and the actual "invalid or already used" message) before the tenant ever saw it. **Fix:** delete the throwaway account *before* lowering the guard, same ordering the success path already used. The real invite error now reaches the screen.
  - **Still to verify:** try redeeming with a deliberately wrong/reused code and confirm the specific error text ("That invite code is invalid or already used.") actually stays on screen instead of the generic toast.

- **Bug fix — deleted locations resurrecting as duplicates in Incognito (this session):** reported as "deleted Paupahan A, should be 3 locations, but reopening shows 4 with 2 Paupahan A." Root cause was actually two compounding bugs:
  1. `queueRecordSync` was fire-and-forget with a swallowed `.catch(() => {})` and no persistence — if the tab closed (or connection dropped) before the Firestore write resolved, the push (including a delete's tombstone) was lost for good, with nothing to retry it. In Incognito this is especially easy to trigger since closing the tab can cut off an in-flight request.
  2. `seedIfEmpty()` ran unconditionally at boot, before the first cloud pull. On a fresh/empty local IndexedDB (exactly what a new Incognito session starts with), it immediately created a **brand-new** "Paupahan A" with its own id — and then the cloud pull layered the old, never-actually-deleted cloud copy on top as a second, separate record. That's the "2 Paupahan A" the user saw.
  - **Fix — durable sync outbox:** added a new IndexedDB store (`_syncOutbox`, bumped `DB_VERSION` to 3). Every queued write is saved there first and only cleared once Firestore confirms it; `flushSyncOutbox()` retries anything still pending on every sync run (sign-in, reconnect, 3-min interval), so an interrupted delete/edit is no longer silently dropped.
  - **Fix — seed/pull ordering:** `seedIfEmpty()` no longer runs at boot when Firebase is enabled. It's now deferred to `onCloudAuthStateChanged`: if signed in, the app pulls/merges cloud data first and only seeds if truly still empty afterward; if signed out (local-only), it seeds right away since no cloud data will ever arrive.
  - **Still to verify:** reproduce the original scenario (delete a location, then reopen in a fresh Incognito window) to confirm the count stays correct and no duplicate reappears. Worth also testing "delete while offline, then reconnect" now that the outbox should carry that delete through.

- **Tenant documents via Firebase Storage (this session):** added a "Documents" section to the tenant detail screen with two slots — ID photo and Signed contract. Add/Replace/Remove all wired to Firebase Storage (`users/{uid}/tenants/{tenantId}/{slot}-{timestamp}.ext`), with the download URL + storage path saved on the tenant record's new `documents` field so it rides along through the existing Firestore sync. 15MB upload cap enforced both client-side and in `storage.rules`. Requires being signed in (Settings → Cloud sync) — there's no local-only fallback for this one, since the whole point is an off-device copy. **Needs Firebase Storage enabled + `storage.rules` published** in console before uploads will actually succeed.
- **PWA offline + versioning (this session):** rewrote `sw.js` with a versioned `CACHE_NAME` (bump `CACHE_VERSION` whenever the shell changes), cache-first app shell, offline navigation fallback, and old-cache cleanup on activate. `manifest.json` filled out properly (icons, standalone display, theme colors, categories). `index.html` now listens for `updatefound`/`controllerchange` and shows a dismissable "Refresh" banner instead of silently reloading a session mid-use. **Needs real `icon-192.png` and `icon-512.png` files** dropped next to `index.html` — the manifest and SW both reference them but no icon files exist yet (see section 7).
- **Cloud sync ported from Pautang Pro (this session):** the full Auth + Firestore module — sign-in/sign-up/sign-out sheet, `queueRecordSync` fire-and-forget push on every write, `pullAndMergeCollection` + `runFullCloudSync` last-write-wins merge on sign-in, `online` event, and a 3-minute auto-sync timer — is now in `index.html`, gated behind `firebaseEnabled`. Same collection shape too: `users/{uid}/{store}/{id}`.
- **Bug fix — deleted locations/units resurrecting after sync:** deleting only removed the record locally, so the next sync pulled the still-present cloud copy right back. Fixed with soft-delete tombstones (`deleted: true, updatedAt`) — `refreshCache()` now filters tombstones out of everything the UI reads, while the raw sync/merge logic still sees them so the delete itself propagates and won't bounce back. Note: any locations/units deleted *before* this fix may still be sitting in Firestore without a tombstone — deleting them again once will properly tombstone and clear them for good.
- Still needed before this does anything: real sign-in testing end-to-end (create an account in the app, confirm data appears in the Firestore console, test airplane-mode-then-reconnect). All the setup — project, config, Firestore, Auth, rules — is done.
- Reused patterns from Pautang Pro / Biryani King POS: local-first + last-write-wins sync (now wired), JSON backup/restore (done, and restored records now also push to the cloud if signed in), PWA install-prompt gotcha (`file://` won't trigger it — documented in README).
- The Overdue view is fully functional now and is the one worth testing first, since it drives the daily workflow.
