# Paupahan Admin Portal (UpaPro) — Firebase → Supabase Migration Guide

Current architecture: IndexedDB local-first storage (`locations`, `units`, `tenants`, `payments`, `meta` stores) with a Firebase Auth + Firestore sync layer using last-write-wins on `updatedAt`, per-user collections at `users/{uid}/{store}/{id}`.

This guide ports that same architecture to Supabase.

## 1. Create the Supabase project
1. Go to supabase.com → New Project. Pick a region close to PH users (Singapore).
2. Save your **Project URL** and **anon public key** (Settings → API).

## 2. Design the schema (mirrors your IndexedDB stores)

Run this in the Supabase SQL editor:

```sql
create extension if not exists "uuid-ossp";

create table locations (
  id text primary key,
  user_id uuid references auth.users not null default auth.uid(),
  data jsonb not null,
  updated_at bigint not null,
  created_at timestamptz default now()
);

create table units (
  id text primary key,
  user_id uuid references auth.users not null default auth.uid(),
  location_id text,
  data jsonb not null,
  updated_at bigint not null,
  created_at timestamptz default now()
);

create table tenants (
  id text primary key,
  user_id uuid references auth.users not null default auth.uid(),
  unit_id text,
  data jsonb not null,
  updated_at bigint not null,
  created_at timestamptz default now()
);

create table payments (
  id text primary key,
  user_id uuid references auth.users not null default auth.uid(),
  tenant_id text,
  unit_id text,
  data jsonb not null,
  updated_at bigint not null,
  created_at timestamptz default now()
);

create index on units (location_id);
create index on tenants (unit_id);
create index on payments (tenant_id);
create index on payments (unit_id);
```

**Why `jsonb data` instead of typed columns:** existing records already have a flexible shape (`fullName`, `dueDay`, `coveredPeriod`, etc.) that IndexedDB doesn't enforce. Storing the whole record as JSONB means the existing `dbPut`/`dbGet` logic barely changes — only the transport layer swaps out. A fully-typed-column version is also possible if easier SQL querying/reporting is wanted later.

## 3. Enable Row Level Security (critical — don't skip)

```sql
alter table locations enable row level security;
alter table units enable row level security;
alter table tenants enable row level security;
alter table payments enable row level security;

create policy "Users manage own rows" on locations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own rows" on units
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own rows" on tenants
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own rows" on payments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Without this, any signed-in user could read/write anyone else's data — Firestore's `users/{uid}/...` path structure enforced this implicitly; Postgres needs explicit policies.

## 4. Swap the SDK in `index.html`

Replace the Firebase compat scripts with:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
```

(Or vendor it locally under `vendor/`, matching the Pautang Pro pattern.)

## 5. Replace `firebaseConfig`/`initFirebase` with a Supabase client

```javascript
const supabaseConfig = {
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR-ANON-KEY"
};
const cloudEnabled = !!supabaseConfig.url;
const SYNCED_STORES = ['locations', 'units', 'tenants', 'payments'];
let sb = null, sbUser = null, cloudSyncBusy = false, cloudAutoTimer = null;

function initCloud() {
  if (!cloudEnabled) return;
  sb = supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey);
  sb.auth.onAuthStateChange((event, session) => onCloudAuthStateChanged(session?.user || null));
  sb.auth.getSession().then(({ data }) => onCloudAuthStateChanged(data.session?.user || null));
}
```

## 6. Port auth calls

| Firebase | Supabase |
|---|---|
| `fbAuth.createUserWithEmailAndPassword(email, pw)` | `sb.auth.signUp({ email, password: pw })` |
| `fbAuth.signInWithEmailAndPassword(email, pw)` | `sb.auth.signInWithPassword({ email, password: pw })` |
| `fbAuth.signOut()` | `sb.auth.signOut()` |
| `fbUser.email` | `sbUser.email` |

Update `cloudAuthErrorMessage` to switch on Supabase's error `.message` text instead of `.code` (Supabase doesn't use Firebase-style error codes).

## 7. Port the sync functions

```javascript
function queueRecordSync(storeName, record) {
  if (!sbUser || !sb) return;
  const { id, updatedAt, ...rest } = record;
  sb.from(storeName).upsert({
    id: String(id),
    user_id: sbUser.id,
    updated_at: updatedAt || Date.now(),
    data: record,
    ...(storeName === 'units' ? { location_id: record.locationId } : {}),
    ...(storeName === 'tenants' ? { unit_id: record.unitId } : {}),
    ...(storeName === 'payments' ? { tenant_id: record.tenantId, unit_id: record.unitId } : {})
  }).then(() => {}).catch(() => {});
}

async function pullAndMergeCollection(storeName) {
  const { data: remoteRows, error } = await sb.from(storeName).select('*').eq('user_id', sbUser.id);
  if (error) throw error;
  const remoteRecords = remoteRows.map(r => r.data);
  const localRecords = await dbGetAll(storeName);
  const localById = new Map(localRecords.map(r => [String(r.id), r]));
  const toPush = [];

  for (const remote of remoteRecords) {
    const key = String(remote.id);
    const local = localById.get(key);
    if (!local) {
      await dbPut(storeName, remote);
    } else {
      const remoteTs = remote.updatedAt || 0;
      const localTs = local.updatedAt || 0;
      if (remoteTs > localTs) await dbPut(storeName, remote);
      else if (localTs > remoteTs) toPush.push(local);
      localById.delete(key);
    }
  }
  for (const local of localById.values()) {
    if (!local.updatedAt) { local.updatedAt = Date.now(); await dbPut(storeName, local); }
    toPush.push(local);
  }

  for (const record of toPush) queueRecordSync(storeName, record);
}
```

This is a near 1:1 port — the last-write-wins merge logic on `updatedAt` doesn't need to change at all, just the read/write calls underneath it. `runFullCloudSync` and `onCloudAuthStateChanged` stay almost identical too, just swap `fbUser`→`sbUser`.

## 8. Realtime (optional upgrade over Firestore)

For live updates across devices instead of polling every 3 minutes:

```javascript
sb.channel('db-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'payments', filter: `user_id=eq.${sbUser.id}` },
    () => runFullCloudSync(false))
  .subscribe();
```

## 9. Data migration (if there are live Firestore users already)

If Pautang Pro or this app already has real users on Firestore, a one-time export/import script is needed rather than a fresh start — reading from Firestore and bulk-inserting into Supabase, run once per user or as a server-side job.

---

**Next step available:** apply this directly to `index.html` — swap the Firebase blocks for Supabase, keeping everything else (UI, IndexedDB layer, render logic) untouched.
