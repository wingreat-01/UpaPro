/* =========================================================
   functions/rentReminders.js — rent due reminder emails (M6)

   WHAT THIS DOES
   Runs once a day (08:00 Asia/Manila). For every tenant whose owner
   has "Rent due reminders" turned on (Settings -> Rent due reminders
   in the app), checks whether their unit's rent is due in exactly
   7 days. If it is — and there's still an outstanding balance for
   that period, and the tenant has completed tenant-portal signup
   (so we have a real, self-provided email on file) — sends a
   reminder email via Resend.

   Deliberately reuses tenant.portalEmail (set when the tenant redeems
   their portal invite — see portalRedeemInvite in index.html) instead
   of a separate admin-entered email field, so there's no double entry
   and no stale/mistyped address risk. The tradeoff: a tenant who was
   never invited to — or never signed up for — the portal won't get
   reminders, since there's no email on file for them at all.

   WHY SERVER-SIDE
   The app is a client-side PWA; it can't reliably fire something
   "every day at 8am" from a phone that might be closed, asleep, or
   offline. This has to live in a Cloud Function on a schedule,
   reading straight from Firestore (the same data the app syncs to).

   DATA MODEL THIS RELIES ON (see index.html)
     users/{adminUid}/tenants/{tenantId}   — fullName, portalEmail, unitId, active
     users/{adminUid}/units/{unitId}       — unitLabel, monthlyRent, dueDay (1-28)
     users/{adminUid}/payments/{paymentId} — tenantId, coveredPeriod (YYYY-MM),
                                              tag ('rent'|'electricity'|'water'|'deposit'),
                                              amountPaid
     users/{adminUid}/settings/reminders   — { enabled: bool }  (Settings toggle)
     users/{adminUid}/rentReminders/{tenantId_period} — idempotency log,
                                              written by THIS function after
                                              a successful send, so a retry
                                              or a second run the same day
                                              never double-emails a tenant.

   SETUP
   1. Drop this file in your functions/ folder next to agent-openrouter.js.
   2. In functions/index.js:
        const { rentDueReminders } = require('./rentReminders');
        exports.rentDueReminders = rentDueReminders;
   3. Get a Resend API key (resend.com) and verify a sending domain —
      Resend's free tier (100 emails/day, 3,000/mo) is plenty for this.
      Swap the fetch() call below for SendGrid's API if you'd rather
      use that instead; the rest of the function doesn't care which
      provider sends the email.
   4. Set the secret + config:
        firebase functions:secrets:set RESEND_API_KEY
        firebase functions:config:set reminders.from="UpaPro <reminders@yourdomain.com>"
      (or use a functions/.env file with RESEND_API_KEY and FROM_EMAIL
      if you're on functions v2 params instead of functions:config)
   5. Deploy: firebase deploy --only functions:rentDueReminders

   FIRESTORE INDEX
   The collectionGroup('tenants').where('active','==',true) query below
   needs a collection-group index on `active`. Firestore will log a
   direct link to create it the first time this runs if it's missing —
   click that link once and it's done.
   ========================================================= */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
// Must be a verified sender/domain in your Resend account.
const FROM_EMAIL = process.env.FROM_EMAIL || 'UpaPro <reminders@yourdomain.com>';

const REMINDER_WINDOW_DAYS = 7;

function peso(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
}

// Same clamp the client uses (unit.dueDay is meant to stay 1-28 so it's
// valid in every month, including February) — kept identical here so the
// server's idea of "due date" never drifts from what the app shows.
function clampDueDay(dueDay) {
  return Math.min(Math.max(Number(dueDay) || 1, 1), 28);
}

// Next occurrence of the unit's due day, on or after today. If this
// month's due day has already passed, rolls to next month — mirrors
// how the app itself decides which period is "current" for a unit.
function nextRentDueDate(dueDay, today) {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const todayMid = new Date(y, m, d);
  let due = new Date(y, m, dueDay);
  if (due < todayMid) due = new Date(y, m + 1, dueDay);
  return due;
}

function periodKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function rentBalanceFor(adminUid, tenantId, period, monthlyRent) {
  const snap = await db.collection('users').doc(adminUid).collection('payments')
    .where('tenantId', '==', tenantId)
    .where('coveredPeriod', '==', period)
    .where('tag', '==', 'rent')
    .get();
  let paid = 0;
  snap.forEach((doc) => { paid += Number(doc.data().amountPaid) || 0; });
  return Math.round((Number(monthlyRent) || 0) - paid);
}

async function sendReminderEmail(apiKey, to, tenantName, unitLabel, amountDue, dueDate) {
  const dueDateLabel = dueDate.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject: `Rent reminder — due ${dueDateLabel}`,
      html: `
        <p>Hi ${tenantName},</p>
        <p>Just a friendly reminder that your rent for <strong>${unitLabel}</strong> is due on
        <strong>${dueDateLabel}</strong> (7 days from now).</p>
        <p>Amount due: <strong>${peso(amountDue)}</strong></p>
        <p>If you've already paid, please disregard this message — payment records can take
        a little while to reflect.</p>
        <p>Thank you!</p>
      `,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body}`);
  }
}

async function isRemindersEnabled(adminUid, cache) {
  if (cache.has(adminUid)) return cache.get(adminUid);
  let enabled = false;
  try {
    const doc = await db.collection('users').doc(adminUid).collection('settings').doc('reminders').get();
    enabled = !!(doc.exists && doc.data().enabled);
  } catch (err) {
    logger.warn(`Failed reading reminders setting for ${adminUid}`, err);
  }
  cache.set(adminUid, enabled);
  return enabled;
}

const rentDueReminders = onSchedule(
  {
    schedule: 'every day 08:00',
    timeZone: 'Asia/Manila',
    secrets: [RESEND_API_KEY],
  },
  async () => {
    const apiKey = RESEND_API_KEY.value();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const enabledCache = new Map(); // adminUid -> bool, so multi-tenant owners aren't re-fetched per tenant
    let sent = 0, skipped = 0, failed = 0;

    const tenantsSnap = await db.collectionGroup('tenants').where('active', '==', true).get();

    for (const tenantDoc of tenantsSnap.docs) {
      const tenant = tenantDoc.data();
      const adminUid = tenantDoc.ref.parent.parent.id;

      try {
        if (!tenant.portalEmail) { skipped++; continue; } // no portal account set up — nothing to send to
        if (!(await isRemindersEnabled(adminUid, enabledCache))) { skipped++; continue; }

        const unitDoc = await db.collection('users').doc(adminUid).collection('units').doc(tenant.unitId).get();
        if (!unitDoc.exists) { skipped++; continue; }
        const unit = unitDoc.data();

        const dueDay = clampDueDay(unit.dueDay);
        const dueDate = nextRentDueDate(dueDay, today);
        const diffDays = Math.round((dueDate - today) / 86400000);
        if (diffDays !== REMINDER_WINDOW_DAYS) { skipped++; continue; }

        const period = periodKey(dueDate);
        const balance = await rentBalanceFor(adminUid, tenantDoc.id, period, unit.monthlyRent);
        if (balance <= 0) { skipped++; continue; } // already settled — nothing to remind about

        const logId = `${tenantDoc.id}_${period}`;
        const logRef = db.collection('users').doc(adminUid).collection('rentReminders').doc(logId);
        const logDoc = await logRef.get();
        if (logDoc.exists) { skipped++; continue; } // already sent for this tenant+period

        await sendReminderEmail(apiKey, tenant.portalEmail, tenant.fullName || 'there', unit.unitLabel || 'your unit', balance, dueDate);
        await logRef.set({ sentAt: Date.now(), email: tenant.portalEmail, amount: balance, period });
        sent++;
      } catch (err) {
        failed++;
        logger.error(`Reminder failed for tenant ${tenantDoc.id} (admin ${adminUid})`, err);
      }
    }

    logger.info(`rentDueReminders done — sent:${sent} skipped:${skipped} failed:${failed}`);
  }
);

module.exports = { rentDueReminders };
