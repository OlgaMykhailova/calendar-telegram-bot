const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TOKEN_CACHE_KEY = 'google:access_token';
const TOKEN_REFRESH_MARGIN_SECONDS = 300;

function base64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const base64 = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '') // key pasted with literal "\n" instead of real newlines
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function parseServiceAccountKey(raw) {
  let key;
  try {
    key = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY must contain client_email and private_key');
  }
  return key;
}

/** Signed JWT for Google's service-account OAuth flow (RS256, via WebCrypto). */
export async function signJwt({ clientEmail, privateKey }, now) {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64url(signature)}`;
}

/**
 * Access token cached in KV for about an hour. Signing an RSA JWT is the only
 * CPU-heavy step in a run, and the free plan allows 10 ms of CPU per invocation.
 */
export async function getAccessToken(env, { now = new Date(), fetchFn = fetch } = {}) {
  const cached = await env.STATE.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const key = parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const assertion = await signJwt({ clientEmail: key.client_email, privateKey: key.private_key }, now);
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);

  const { access_token: token, expires_in: expiresIn } = await res.json();
  await env.STATE.put(TOKEN_CACHE_KEY, token, {
    expirationTtl: Math.max(60, expiresIn - TOKEN_REFRESH_MARGIN_SECONDS),
  });
  return token;
}

/**
 * Events starting within `windowMinutes`. Google filters `timeMin` by event end,
 * so events that already started can come back too; callers filter by start.
 */
export async function listUpcomingEvents(env, { now, windowMinutes, fetchFn = fetch }) {
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + windowMinutes * 60_000).toISOString(),
    singleEvents: 'true', // expand recurring events into separate instances
    orderBy: 'startTime',
    maxResults: '50',
    fields: 'items(id,status,summary,location,hangoutLink,htmlLink,start,end)',
  });
  const url = `${EVENTS_URL}/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events?${params}`;

  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(env, { now, fetchFn });
    const res = await fetchFn(url, { headers: { authorization: `Bearer ${token}` } });

    if (res.status === 401 && attempt === 0) {
      // The cached token was revoked or expired early: drop it and retry once.
      await env.STATE.delete(TOKEN_CACHE_KEY);
      continue;
    }
    if (!res.ok) {
      const hint =
        res.status === 403 || res.status === 404
          ? ' (check GOOGLE_CALENDAR_ID and that the calendar is shared with the service account)'
          : '';
      throw new Error(`Google Calendar request failed: ${res.status} ${await res.text()}${hint}`);
    }
    return (await res.json()).items ?? [];
  }
}
