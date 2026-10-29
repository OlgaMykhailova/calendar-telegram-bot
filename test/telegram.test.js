import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sendMessage } from '../src/telegram.js';
import { createFetch, json } from './helpers.js';

const env = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' };
const API = 'https://api.telegram.org/bot123:abc/sendMessage';

function recordSleeps() {
  const sleeps = [];
  return { sleeps, sleepFn: async (ms) => void sleeps.push(ms) };
}

describe('sendMessage', () => {
  test('posts an HTML message to the configured chat', async () => {
    const fetchFn = createFetch([[API, () => json({ ok: true })]]);

    await sendMessage(env, '<b>hi</b>', { fetchFn });

    assert.equal(fetchFn.calls.length, 1);
    assert.equal(fetchFn.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), {
      chat_id: '42',
      text: '<b>hi</b>',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  test('waits for retry_after on 429 and then succeeds', async () => {
    const { sleeps, sleepFn } = recordSleeps();
    let calls = 0;
    const fetchFn = createFetch([
      [
        API,
        () =>
          ++calls === 1
            ? json({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } }, 429)
            : json({ ok: true }),
      ],
    ]);

    await sendMessage(env, 'hi', { fetchFn, sleepFn });

    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  test('does not hold the run for a long retry_after', async () => {
    const { sleeps, sleepFn } = recordSleeps();
    const fetchFn = createFetch([
      [API, () => json({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 600 } }, 429)],
    ]);

    await assert.rejects(sendMessage(env, 'hi', { fetchFn, sleepFn }), /429/);
    assert.equal(fetchFn.calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  test('retries network errors and never leaks the token in the error', async () => {
    const { sleeps, sleepFn } = recordSleeps();
    let calls = 0;
    const fetchFn = createFetch([
      [
        API,
        () => {
          if (++calls === 1) throw new TypeError(`fetch failed: ${API}`);
          return json({ ok: true });
        },
      ],
    ]);

    await sendMessage(env, 'hi', { fetchFn, sleepFn });
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [1000]);

    const alwaysFails = createFetch([
      [
        API,
        () => {
          throw new TypeError(`fetch failed: ${API}`);
        },
      ],
    ]);
    await assert.rejects(sendMessage(env, 'hi', { fetchFn: alwaysFails, sleepFn }), (err) => {
      assert.doesNotMatch(err.message, /123:abc/);
      return true;
    });
    assert.equal(alwaysFails.calls.length, 3);
  });

  test('retries 5xx and gives up after the last attempt', async () => {
    const { sleepFn } = recordSleeps();
    const fetchFn = createFetch([[API, () => json({ ok: false, description: 'Bad Gateway' }, 502)]]);

    await assert.rejects(sendMessage(env, 'hi', { fetchFn, sleepFn }), /502 Bad Gateway/);
    assert.equal(fetchFn.calls.length, 3);
  });

  test('fails fast on other 4xx without retrying and redacts the token', async () => {
    const { sleeps, sleepFn } = recordSleeps();
    const fetchFn = createFetch([
      [API, () => json({ ok: false, description: 'Unauthorized: bad token 123:abc' }, 401)],
    ]);

    await assert.rejects(sendMessage(env, 'hi', { fetchFn, sleepFn }), (err) => {
      assert.match(err.message, /401 Unauthorized/);
      assert.doesNotMatch(err.message, /123:abc/);
      return true;
    });
    assert.equal(fetchFn.calls.length, 1);
    assert.deepEqual(sleeps, []);
  });
});
