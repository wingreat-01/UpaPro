# UpaPro — AI Automation / "AI Employee" Sketch Plan

Status: Draft / brainstorm
Owner: Kas
Last updated: 2026-07-15

## 1. Concept

Add an AI assistant to the **admin tenant portal** of UpaPro that behaves like a junior
property-management employee: it watches the data (tenants, units, payments, invite codes,
payment proofs) and proactively does the boring parts of the job — reminders, flagging,
drafting messages, summarizing status — instead of just answering questions when asked.

Two layers, don't conflate them:
- **AI Assistant (chat/copilot)** — admin asks it things, it answers using live data.
- **AI Automation (agent/employee)** — runs on a schedule or trigger, takes actions on its
  own within guardrails (e.g. "flag tenant as 5 days overdue and draft a reminder").

Start with the first, treat the second as an extension once trust is established.

## 2. Why a home desktop as the server

You're planning to use your house desktop as a lightweight VPS instead of paying for cloud
hosting. That's viable for this feature since the workload is bursty and low-traffic, but a
few constraints shape the design:

- **No static public IP** (most residential ISPs in PH) → need a tunnel, not direct port
  forwarding.
- **Uptime isn't guaranteed** (power, ISP outages, reboots) → automations must be safe to
  miss a run and catch up later, not time-critical.
- **Security surface** — anything you expose becomes a target. This matters more given the
  recent malware/RiskWare incident on a Windows machine. **Do not turn a previously
  infected machine into an internet-facing server without a clean OS reinstall first.**
  Treat this as a hard prerequisite, not a nice-to-have.

### Exposure options (pick one)
| Option | Notes |
|---|---|
| Cloudflare Tunnel (`cloudflared`) | No open ports, free tier, gives you a stable subdomain, built-in TLS. Best fit for this use case. |
| Tailscale / Tailscale Funnel | Good if only you need access; Funnel can expose publicly too. |
| Dynamic DNS + port forward | Works but exposes your home IP/router directly — avoid unless firewalled carefully. |
| ngrok | Fine for dev/testing, less ideal for "always-on" production. |

Recommendation: **Cloudflare Tunnel**, run as a Windows service, pointing at a local Node
process. Keeps your router closed, gives you a real domain (e.g. `ai.upapro.app` or a
subdomain of what you already use), and is free.

## 3. High-level architecture

```
Admin Tenant Portal (browser)
        │
        ▼
UpaPro frontend (existing single-file/IndexedDB app)
        │  fetch()
        ▼
Cloudflare Tunnel  ──────────────►  Home Desktop (Windows)
                                      │
                                      ├─ Node.js API server (new)
                                      │     - /assistant/chat
                                      │     - /automation/run (cron-triggered)
                                      │
                                      ├─ Calls Anthropic API (Claude) for reasoning
                                      │
                                      └─ Reads/writes:
                                            - Firestore (tenants, units, payments)
                                            - Supabase Storage (payment proof images)
```

Key decision: **the AI server is a thin orchestration layer, not a new source of truth.**
It reads/writes the same Firestore/Supabase your app already uses, so the admin portal and
tenant portal stay authoritative and in sync. No parallel database.

## 4. AI Assistant (Phase 1 — chat/copilot)

- Add a chat panel in the admin portal (probably a slide-out, similar pattern to Pia in
  Pautang Pro).
- Backend endpoint takes the admin's question, gathers relevant context (recent payments,
  overdue tenants, occupancy), and calls Claude with that context injected into the prompt.
- Start read-only: "who's overdue this month", "summarize occupancy for Building 2",
  "draft a message to unit 4B about their late payment".
- Output for drafts (messages, reminders) should be **presented to the admin for
  approval**, not sent automatically, at this phase.

### Example prompt shape
```
System: You are an assistant for a property manager using UpaPro. You have access to the
following live data snapshot: {tenants_json}. Answer concisely and flag anything overdue.

User: <admin's question>
```

Keep the injected data snapshot small and scoped (e.g. only the relevant building/tenant),
not the entire database, to control cost and latency.

## 5. AI Automation (Phase 2 — "employee" behaviors)

Once Phase 1 is trusted, add scheduled/triggered jobs that act with limited autonomy:

| Automation | Trigger | Action |
|---|---|---|
| Rent due reminder | Daily cron | Draft (or send, if enabled) a reminder to tenants X days before due date |
| Overdue flagging | Daily cron | Mark tenant status, notify admin with a summary |
| Payment proof triage | On new upload (Supabase webhook or poll) | Pre-check image is legible, extract amount if visible, flag mismatches for admin review |
| Weekly digest | Weekly cron | Summarize occupancy, income, and issues, post into admin dashboard or email |
| Invite code follow-up | On unused invite code aging out | Nudge admin to resend or revoke |

Guardrails:
- **Every automation has an on/off toggle per building/tenant**, not just global.
- **Nothing that touches money or tenant communication auto-sends by default** — require an
  explicit "auto-send enabled" opt-in per automation, with a log of everything it did.
- Log every automation run (what it read, what it decided, what it did) to a
  `automation_logs` collection so you can audit/debug later.

## 6. Data & integration notes

- Reuse existing Firebase Auth for admin identity; the Node server should authenticate
  requests via Firebase ID token verification (`firebase-admin` SDK), not a separate login.
- Supabase Storage access from the server uses a service-role key — **keep this only on the
  server, never shipped to the frontend**, and store it in an env var / `.env` excluded from
  git.
- Anthropic API key same treatment — server-side only.
- Since the frontend is IndexedDB-first with sync, the automation server should write
  through the same sync path (Firestore) rather than a side-channel, so tenant/admin clients
  pick up changes through the existing sync logic instead of needing new listeners.

## 7. Rough build order

1. Harden the home desktop (clean reinstall recommended given recent infection) before
   exposing anything publicly.
2. Set up Cloudflare Tunnel + a minimal Node/Express server, confirm it's reachable at a
   subdomain.
3. Wire Firebase Admin SDK + Supabase service client into the server.
4. Build `/assistant/chat` endpoint, wire up a simple chat UI in the admin portal (read-only
   Q&A first).
5. Add the first automation (rent due reminders) in **draft-only mode** — it prepares
   messages but admin manually sends.
6. Add automation logging + per-tenant/building toggles.
7. Only after that's stable, consider enabling auto-send for low-risk automations (e.g.
   internal admin digest — no external message risk).

## 8. Open questions to resolve before building

- Where do tenants actually receive messages today (SMS, in-app, email, Messenger)? This
  decides what "send" even means for automations.
- What's acceptable latency for the assistant chat — is a home-desktop round trip (tunnel +
  Claude API) fast enough, or does it need a fallback/cache?
- Backup plan if the home desktop is off — should automations queue and catch up, or is a
  missed day acceptable? (Recommend: acceptable, log it, catch up next run.)
- Cost control — cap tokens/context per call, and consider a daily automation run cap so a
  bug can't spam tenants or blow through API spend.
