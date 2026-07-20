/**
 * storage-proxy — the compute layer UpaPro's file storage was missing.
 *
 * Before this Worker, the browser talked to Supabase Storage directly with
 * a shared anon key. Storage had no way to check who was actually asking,
 * so that one key could read or write ANY tenant's files, not just the
 * caller's own — permissive RLS policies were doing all the "access
 * control," and they applied to everyone identically.
 *
 * This Worker sits in front of Storage instead. For every request it:
 *   1. Verifies the caller's Firebase ID token (signature, issuer,
 *      audience, expiry) against Google's published keys — nothing here
 *      trusts a token it hasn't checked itself.
 *   2. Confirms the caller actually owns the file being touched:
 *        - self: the token's uid matches the {uid} segment of the path
 *          (a tenant reading/uploading/deleting their own folder)
 *        - cross-tenant read: an admin viewing a tenant's file — checked
 *          by querying that admin's own `tenants` subcollection in
 *          Firestore for a `portalUid` match, using the caller's own ID
 *          token as the Firestore request credential. Firestore re-verifies
 *          the token and applies your existing firestore.rules, so this
 *          reuses the ownership rules you already have instead of
 *          duplicating them here.
 *   3. Only then calls Supabase Storage, using the service-role key, which
 *      never reaches the browser.
 *
 * Deploy with Wrangler — see ../README.md.
 */

const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const SIGN_TTL_SECONDS = 3600;
const PATH_PATTERN = /^portalUploads\/([A-Za-z0-9_-]+)\/[A-Za-z0-9._-]+$/;

let cachedJwks = null;
let cachedJwksAt = 0;

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') return corsPreflight(allowOrigin);
    if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 405, allowOrigin);

    if (!env.FIREBASE_PROJECT_ID || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_BUCKET) {
      return jsonError('WORKER_NOT_CONFIGURED', 500, allowOrigin);
    }

    const authHeader = request.headers.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return jsonError('MISSING_TOKEN', 401, allowOrigin);

    let claims;
    try {
      claims = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
    } catch (err) {
      return jsonError('INVALID_TOKEN', 401, allowOrigin);
    }
    const callerUid = claims.sub;

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError('BAD_JSON', 400, allowOrigin);
    }
    const { action, path, contentType } = body || {};
    if (!action || !path) return jsonError('MISSING_FIELDS', 400, allowOrigin);

    const match = PATH_PATTERN.exec(path);
    if (!match) return jsonError('BAD_PATH', 400, allowOrigin);
    const ownerUid = match[1];
    const isSelf = ownerUid === callerUid;

    if (!isSelf) {
      // Only reads cross tenant boundaries (an admin viewing a tenant's
      // document) — uploads and deletes are always self-service, matching
      // how the app itself is written (only the tenant portal ever
      // uploads or deletes; the admin side only views).
      if (action !== 'read') return jsonError('FORBIDDEN', 403, allowOrigin);
      let owns = false;
      try {
        owns = await callerOwnsTenant(idToken, env.FIREBASE_PROJECT_ID, callerUid, ownerUid);
      } catch (err) {
        owns = false;
      }
      if (!owns) return jsonError('FORBIDDEN', 403, allowOrigin);
    }

    try {
      if (action === 'read') {
        const signedUrl = await createSignedUrl(env, path);
        return jsonOk({ signedUrl }, allowOrigin);
      }
      if (action === 'upload') {
        const signedUrl = await createSignedUploadUrl(env, path);
        return jsonOk({ signedUrl }, allowOrigin);
      }
      if (action === 'delete') {
        await removeObject(env, path);
        return jsonOk({ deleted: true }, allowOrigin);
      }
      return jsonError('UNKNOWN_ACTION', 400, allowOrigin);
    } catch (err) {
      return jsonError('STORAGE_ERROR', 502, allowOrigin);
    }
  },
};

/* ------------------------------ Firebase ID token verification ------------------------------
   Manual verification per Google's documented steps — there's no Firebase
   Admin SDK in the Workers runtime, so this checks the RS256 signature
   against Google's published JWKs directly, then the standard claims. */

async function getFirebaseJwks() {
  const now = Date.now();
  if (cachedJwks && now - cachedJwksAt < 6 * 60 * 60 * 1000) return cachedJwks;
  const res = await fetch(FIREBASE_JWKS_URL);
  if (!res.ok) throw new Error('JWKS_FETCH_FAILED');
  const jwks = await res.json();
  cachedJwks = jwks;
  cachedJwksAt = now;
  return jwks;
}

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('MALFORMED_TOKEN');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = base64UrlDecodeJson(headerB64);
  const payload = base64UrlDecodeJson(payloadB64);

  if (header.alg !== 'RS256') throw new Error('UNSUPPORTED_ALG');

  const jwks = await getFirebaseJwks();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('UNKNOWN_KID');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(sigB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedData);
  if (!valid) throw new Error('BAD_SIGNATURE');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('TOKEN_EXPIRED');
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('TOKEN_NOT_YET_VALID');
  if (payload.aud !== projectId) throw new Error('BAD_AUDIENCE');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('BAD_ISSUER');
  if (!payload.sub) throw new Error('NO_SUBJECT');

  return payload;
}

/* ------------------------------ Firestore ownership check ------------------------------
   Queries users/{callerUid}/tenants for a doc with portalUid == targetUid,
   using the caller's own (already-verified) ID token as the Firestore
   request credential — so Firestore re-checks the token itself and
   enforces your existing firestore.rules on top, rather than this Worker
   re-implementing that logic separately. */

async function callerOwnsTenant(idToken, projectId, callerUid, targetUid) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(callerUid)}:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'tenants' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'portalUid' },
          op: 'EQUAL',
          value: { stringValue: targetUid },
        },
      },
      limit: 1,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.some((row) => row && row.document);
}

/* ------------------------------ Supabase Storage (service-role) ------------------------------ */

function encodeStoragePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function createSignedUrl(env, path) {
  const res = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/sign/${env.SUPABASE_BUCKET}/${encodeStoragePath(path)}`,
    {
      method: 'POST',
      headers: supabaseHeaders(env),
      body: JSON.stringify({ expiresIn: SIGN_TTL_SECONDS }),
    }
  );
  if (!res.ok) throw new Error(`sign failed: ${res.status}`);
  const data = await res.json();
  return `${env.SUPABASE_URL}${data.signedURL}`;
}

async function createSignedUploadUrl(env, path) {
  const res = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/upload/sign/${env.SUPABASE_BUCKET}/${encodeStoragePath(path)}`,
    {
      method: 'POST',
      headers: supabaseHeaders(env),
      body: JSON.stringify({ upsert: true }),
    }
  );
  if (!res.ok) throw new Error(`sign-upload failed: ${res.status}`);
  const data = await res.json();
  return `${env.SUPABASE_URL}${data.url}`;
}

async function removeObject(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/remove/${env.SUPABASE_BUCKET}`, {
    method: 'POST',
    headers: supabaseHeaders(env),
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!res.ok) throw new Error(`remove failed: ${res.status}`);
}

function supabaseHeaders(env) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/* ------------------------------ HTTP helpers ------------------------------ */

function corsHeaders(allowOrigin) {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function corsPreflight(allowOrigin) {
  return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
}

function jsonOk(data, allowOrigin) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(allowOrigin) },
  });
}

function jsonError(code, status, allowOrigin) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(allowOrigin) },
  });
}
