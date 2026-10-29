// Shared fakes for the tests. Not a test file itself (the test script only runs *.test.js).

export const NOW = new Date('2026-10-29T10:00:00Z');

/** A timed calendar event starting `offsetSeconds` after NOW (in the shape the Calendar API returns). */
export function eventAt(offsetSeconds, overrides = {}) {
  const start = new Date(NOW.getTime() + offsetSeconds * 1000);
  const end = new Date(start.getTime() + 30 * 60_000);
  return {
    id: 'evt1',
    status: 'confirmed',
    summary: 'Планерка',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
    ...overrides,
  };
}

/** In-memory stand-in for a Workers KV namespace. */
export class FakeKV {
  constructor() {
    this.store = new Map();
    this.ttls = new Map();
  }

  async get(key) {
    return this.store.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    this.store.set(key, value);
    this.ttls.set(key, options.expirationTtl);
  }

  async delete(key) {
    this.store.delete(key);
    this.ttls.delete(key);
  }
}

let serviceAccount;

/** A real RSA service-account key (generated once per test file), so JWT signing is exercised for real. */
export function getServiceAccount() {
  serviceAccount ??= (async () => {
    const { publicKey, privateKey } = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey));
    const body = der.toString('base64').match(/.{1,64}/g).join('\n');
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    return {
      publicKey,
      clientEmail: 'bot@example.iam.gserviceaccount.com',
      privateKeyPem: pem,
      json: JSON.stringify({
        type: 'service_account',
        client_email: 'bot@example.iam.gserviceaccount.com',
        private_key: pem,
      }),
    };
  })();
  return serviceAccount;
}

export async function makeEnv(overrides = {}) {
  const account = await getServiceAccount();
  return {
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '42',
    GOOGLE_CALENDAR_ID: 'team@example.com',
    GOOGLE_SERVICE_ACCOUNT_KEY: account.json,
    REMINDER_MINUTES: '5',
    TIMEZONE: 'Europe/Kyiv',
    STATE: new FakeKV(),
    ...overrides,
  };
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Fake `fetch` that routes by URL prefix: `routes` is a list of [prefix, handler(url, init)].
 * Every call is recorded in `fetchFn.calls`.
 */
export function createFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    for (const [prefix, handler] of routes) {
      if (target.startsWith(prefix)) return handler(target, init);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

export const noSleep = async () => {};
