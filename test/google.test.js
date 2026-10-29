import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getAccessToken, listUpcomingEvents, signJwt } from '../src/google.js';
import { createFetch, FakeKV, getServiceAccount, json, makeEnv, NOW } from './helpers.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/';

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

describe('signJwt', () => {
  test('produces an RS256 JWT with the right claims and a valid signature', async () => {
    const account = await getServiceAccount();
    const jwt = await signJwt(
      { clientEmail: account.clientEmail, privateKey: account.privateKeyPem },
      NOW,
    );

    const [header, claims, signature] = jwt.split('.');
    assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(decode(claims), {
      iss: account.clientEmail,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      aud: TOKEN_URL,
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 3600,
    });

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      account.publicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    assert.equal(valid, true);
  });
});

describe('getAccessToken', () => {
  test('exchanges the JWT once and serves later calls from the KV cache', async () => {
    const env = await makeEnv();
    const fetchFn = createFetch([
      [TOKEN_URL, () => json({ access_token: 'tok', expires_in: 3600 })],
    ]);

    assert.equal(await getAccessToken(env, { now: NOW, fetchFn }), 'tok');
    assert.equal(await getAccessToken(env, { now: NOW, fetchFn }), 'tok');

    assert.equal(fetchFn.calls.length, 1);
    const body = new URLSearchParams(fetchFn.calls[0].init.body);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(body.get('assertion').split('.').length, 3);
    assert.equal(env.STATE.ttls.get('google:access_token'), 3300); // 1 h minus a 5 min safety margin
  });

  test('rejects a malformed service account key with a clear message', async () => {
    const env = await makeEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: 'not json', STATE: new FakeKV() });
    await assert.rejects(getAccessToken(env, { now: NOW, fetchFn: createFetch([]) }), /not valid JSON/);
  });

  test('surfaces Google token errors', async () => {
    const env = await makeEnv();
    const fetchFn = createFetch([[TOKEN_URL, () => json({ error: 'invalid_grant' }, 400)]]);
    await assert.rejects(getAccessToken(env, { now: NOW, fetchFn }), /token request failed: 400/);
  });
});

describe('listUpcomingEvents', () => {
  test('queries the configured calendar for the reminder window', async () => {
    const env = await makeEnv();
    const fetchFn = createFetch([
      [TOKEN_URL, () => json({ access_token: 'tok', expires_in: 3600 })],
      [EVENTS_URL, () => json({ items: [{ id: 'evt1' }] })],
    ]);

    const events = await listUpcomingEvents(env, { now: NOW, windowMinutes: 5, fetchFn });

    assert.deepEqual(events, [{ id: 'evt1' }]);
    const request = fetchFn.calls.find((call) => call.url.startsWith(EVENTS_URL));
    const url = new URL(request.url);
    assert.equal(url.pathname, '/calendar/v3/calendars/team%40example.com/events');
    assert.equal(url.searchParams.get('timeMin'), '2026-10-29T10:00:00.000Z');
    assert.equal(url.searchParams.get('timeMax'), '2026-10-29T10:05:00.000Z');
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    assert.equal(url.searchParams.get('orderBy'), 'startTime');
    assert.equal(request.init.headers.authorization, 'Bearer tok');
  });

  test('refreshes a rejected cached token and retries once', async () => {
    const env = await makeEnv();
    await env.STATE.put('google:access_token', 'stale');
    let eventsCalls = 0;
    const fetchFn = createFetch([
      [TOKEN_URL, () => json({ access_token: 'fresh', expires_in: 3600 })],
      [
        EVENTS_URL,
        (_url, init) => {
          eventsCalls++;
          return init.headers.authorization === 'Bearer stale'
            ? json({ error: { message: 'Invalid Credentials' } }, 401)
            : json({ items: [] });
        },
      ],
    ]);

    assert.deepEqual(await listUpcomingEvents(env, { now: NOW, windowMinutes: 5, fetchFn }), []);
    assert.equal(eventsCalls, 2);
    assert.equal(await env.STATE.get('google:access_token'), 'fresh');
  });

  test('hints at sharing when the calendar is not found', async () => {
    const env = await makeEnv();
    const fetchFn = createFetch([
      [TOKEN_URL, () => json({ access_token: 'tok', expires_in: 3600 })],
      [EVENTS_URL, () => json({ error: { message: 'Not Found' } }, 404)],
    ]);
    await assert.rejects(
      listUpcomingEvents(env, { now: NOW, windowMinutes: 5, fetchFn }),
      /404[\s\S]*shared with the service account/,
    );
  });
});
