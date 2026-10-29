import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runReminderJob } from '../src/job.js';
import { dedupeKey } from '../src/reminders.js';
import { createFetch, eventAt, json, makeEnv, noSleep, NOW } from './helpers.js';

const minutesAfterNow = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

function makeFetch({ events, telegram = () => json({ ok: true }) }) {
  return createFetch([
    ['https://oauth2.googleapis.com/token', () => json({ access_token: 'tok', expires_in: 3600 })],
    ['https://www.googleapis.com/calendar/v3/calendars/', () => json({ items: events })],
    ['https://api.telegram.org/', (_url, init) => telegram(JSON.parse(init.body))],
  ]);
}

const telegramCalls = (fetchFn) =>
  fetchFn.calls.filter((call) => call.url.startsWith('https://api.telegram.org/'));

describe('runReminderJob', () => {
  test('sends a reminder to the configured chat for an event starting in 4 minutes', async () => {
    const env = await makeEnv();
    const fetchFn = makeFetch({ events: [eventAt(240)] });

    const sent = await runReminderJob(env, { now: NOW, fetchFn, sleepFn: noSleep });

    assert.deepEqual(sent, ['evt1']);
    const [call] = telegramCalls(fetchFn);
    const body = JSON.parse(call.init.body);
    assert.equal(body.chat_id, '42');
    assert.match(body.text, /Через 4 хв/);
    assert.match(body.text, /Планерка/);
  });

  test('does nothing when no event is due', async () => {
    const env = await makeEnv();
    const fetchFn = makeFetch({
      events: [eventAt(600), eventAt(-300, { id: 'running' }), eventAt(120, { id: 'x', status: 'cancelled' })],
    });

    assert.deepEqual(await runReminderJob(env, { now: NOW, fetchFn, sleepFn: noSleep }), []);
    assert.equal(telegramCalls(fetchFn).length, 0);
  });

  test('announces an event only once across consecutive runs', async () => {
    const env = await makeEnv();
    const fetchFn = makeFetch({ events: [eventAt(240)] });

    await runReminderJob(env, { now: NOW, fetchFn, sleepFn: noSleep });
    await runReminderJob(env, { now: minutesAfterNow(1), fetchFn, sleepFn: noSleep });
    await runReminderJob(env, { now: minutesAfterNow(3), fetchFn, sleepFn: noSleep });

    assert.equal(telegramCalls(fetchFn).length, 1);
    assert.ok(env.STATE.ttls.get(dedupeKey(eventAt(240))) > 0, 'the sent marker expires on its own');
  });

  test('reminds again when the event is moved to another time', async () => {
    const env = await makeEnv();
    const events = [eventAt(240)];
    const fetchFn = makeFetch({ events });

    await runReminderJob(env, { now: NOW, fetchFn, sleepFn: noSleep });
    events[0] = eventAt(15 * 60); // moved to 10:15
    await runReminderJob(env, { now: minutesAfterNow(11), fetchFn, sleepFn: noSleep });

    assert.equal(telegramCalls(fetchFn).length, 2);
  });

  test('retries on the next run when Telegram rejects the message', async () => {
    const env = await makeEnv();
    let telegramDown = true;
    const fetchFn = makeFetch({
      events: [eventAt(240)],
      telegram: () => (telegramDown ? json({ ok: false, description: 'chat not found' }, 400) : json({ ok: true })),
    });

    await assert.rejects(
      runReminderJob(env, { now: NOW, fetchFn, sleepFn: noSleep }),
      /Telegram sendMessage failed: 400 chat not found/,
    );
    assert.equal(await env.STATE.get(dedupeKey(eventAt(240))), null, 'the claim is released');

    telegramDown = false;
    const sent = await runReminderJob(env, { now: minutesAfterNow(1), fetchFn, sleepFn: noSleep });
    assert.deepEqual(sent, ['evt1']);
  });

  test('still announces the other events when one of them fails', async () => {
    const env = await makeEnv();
    const fetchFn = makeFetch({
      events: [
        eventAt(120, { id: 'a', summary: 'Fail me' }),
        eventAt(180, { id: 'b', summary: 'Fine' }),
      ],
      telegram: (body) =>
        body.text.includes('Fail me') ? json({ ok: false, description: 'nope' }, 400) : json({ ok: true }),
    });

    await assert.rejects(runReminderJob(env, { now: NOW, fetchFn, sleepFn: noSleep }), /nope/);

    const texts = telegramCalls(fetchFn).map((call) => JSON.parse(call.init.body).text);
    assert.ok(texts.some((text) => text.includes('Fine')));
    assert.equal(await env.STATE.get(dedupeKey(eventAt(120, { id: 'a' }))), null);
    assert.ok(await env.STATE.get(dedupeKey(eventAt(180, { id: 'b' }))));
  });

  test('honours REMINDER_MINUTES', async () => {
    const env = await makeEnv({ REMINDER_MINUTES: '10' });
    const fetchFn = makeFetch({ events: [eventAt(9 * 60)] });

    assert.deepEqual(await runReminderJob(env, { now: NOW, fetchFn, sleepFn: noSleep }), ['evt1']);
    const calendarCall = fetchFn.calls.find((call) => call.url.includes('/events?'));
    assert.equal(new URL(calendarCall.url).searchParams.get('timeMax'), '2026-10-29T10:10:00.000Z');
  });

  test('reports missing configuration up front', async () => {
    const env = await makeEnv({ TELEGRAM_BOT_TOKEN: '', GOOGLE_CALENDAR_ID: undefined });
    const fetchFn = makeFetch({ events: [] });

    await assert.rejects(
      runReminderJob(env, { now: NOW, fetchFn }),
      /Missing configuration: TELEGRAM_BOT_TOKEN, GOOGLE_CALENDAR_ID/,
    );
    assert.equal(fetchFn.calls.length, 0);
  });

  test('rejects an invalid REMINDER_MINUTES', async () => {
    const env = await makeEnv({ REMINDER_MINUTES: 'soon' });
    await assert.rejects(
      runReminderJob(env, { now: NOW, fetchFn: makeFetch({ events: [] }) }),
      /REMINDER_MINUTES must be a positive number/,
    );
  });
});
