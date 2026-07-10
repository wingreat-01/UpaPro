# UpaPro — Admin Portal (v1 build)

This is the M1–M3 build from `tenant-admin-portal-plan.md`: a working, single-file
`index.html` app you can open directly in a browser or host anywhere static
files work (Firebase Hosting, GitHub Pages, Vercel).

## What's implemented

- **M1 — Data layer:** IndexedDB (`upapro_db`) with `locations`,
  `units`, `tenants`, `payments`, `meta` stores and full CRUD.
- **M2 — Core screens:** Dashboard, Locations list, Location → Units
  drill-down, Unit detail (tenant info + payment history), add/edit
  location, add/edit unit, assign/edit tenant, log payment, move-out flow,
  tenant search across all locations, JSON backup export/import.
- **M3 — Overdue/reporting:** Dashboard surfaces the top few due/overdue
  tenants; the dedicated **Overdue** tab shows the full cross-location list,
  sorted overdue-first. This is the daily-use screen per the plan.
- Mobile-first layout (~390px design width), bottom tab nav, bottom-sheet
  modals for all forms, one-handed numeric input (`inputmode="decimal"`),
  `manifest.json` + a minimal app-shell `sw.js` so it's installable from
  day one (real offline/versioning strategy is still M5).

## Design decisions locked in (per your plan's open questions)

- **Admin users:** single admin for v1, as you confirmed — no login/auth
  gating yet, no `role`/`locationsAssigned` fields. Multi-user is a v2 item
  in the plan; when you're ready I'd add a lightweight `admin` config in
  `meta` plus Firestore security rules scoped by `locationsAssigned`.
- **Rent cycle:** fixed monthly **due day per unit** (`unit.dueDay`,
  1–28), not per-tenant. Simpler to reason about across ~20 units and
  matches the first option in your plan. Easy to move to per-tenant later
  if a location needs it.
- **Partial payments:** allowed. `payment.status` is `paid` / `partial`
  (auto-computed from amount vs. rent) / `late` (available for manual use,
  e.g. logging a late full payment).
- **Deposit:** a single field on the tenant record (`depositAmount`), not
  a ledger line. If you'd rather track deposit refunds as their own
  ledger entries later, that's a small schema addition.

I made these calls so the build wasn't blocked — flag anything you want
reversed and it's a quick change.

## Not yet built (by design — later milestones)

- **M4 — Firebase:** the app runs fully local-first right now. There's a
  clearly marked hook (`firebaseConfig` near the top of the `<script>`
  block) — drop in your real project config there and the sync module can
  be wired the same way Pautang Pro does it (Auth + Firestore,
  last-write-wins, tested with airplane-mode-then-reconnect).
- **M5 — Mobile polish:** the manifest/service worker here are stubs
  (cache the shell, nothing fancier). Icons are placeholders
  (`icon-192.png`, `icon-512.png`) — swap for real artwork before Play
  Store submission. Real-device testing on Android Chrome still needed.
- **M6 — Play Store packaging:** TWA via PWABuilder, `assetlinks.json`,
  store listing, privacy policy — same path as Pautang Pro.
- **Nice-to-haves not built:** receipt generator, Excel/PDF export, due-date
  reminders, photo attachments, theme toggle.

## Files

- `index.html` — the entire app (data layer, all screens, forms)
- `manifest.json` — PWA manifest
- `sw.js` — minimal app-shell service worker
- `icon-192.png`, `icon-512.png` — placeholder app icons

## Try it now

Just open `index.html` in a browser (or serve it over `https://`/`localhost`
if you want the install prompt to work — `file://` won't trigger it, same
issue you already hit with Biryani King). It seeds one sample location and
unit on first run so the screens aren't empty.
