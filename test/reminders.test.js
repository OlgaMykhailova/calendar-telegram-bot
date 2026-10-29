import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dedupeKey, findDueEvents, formatMessage, minutesUntil } from '../src/reminders.js';
import { eventAt, NOW } from './helpers.js';

describe('findDueEvents', () => {
  test('includes events starting within the reminder window, boundary included', () => {
    const due = findDueEvents([eventAt(240, { id: 'a' }), eventAt(300, { id: 'b' })], NOW, 5);
    assert.deepEqual(due.map((e) => e.id), ['a', 'b']);
  });

  test('excludes events too far away, already started, or starting right now', () => {
    const events = [
      eventAt(301, { id: 'later' }),
      eventAt(0, { id: 'now' }),
      eventAt(-60, { id: 'started' }),
    ];
    assert.deepEqual(findDueEvents(events, NOW, 5), []);
  });

  test('ignores all-day and cancelled events', () => {
    const events = [
      eventAt(120, { id: 'all-day', start: { date: '2026-10-29' }, end: { date: '2026-10-30' } }),
      eventAt(120, { id: 'cancelled', status: 'cancelled' }),
    ];
    assert.deepEqual(findDueEvents(events, NOW, 5), []);
  });

  test('respects a custom reminder window', () => {
    const events = [eventAt(540, { id: 'nine' })];
    assert.equal(findDueEvents(events, NOW, 5).length, 0);
    assert.equal(findDueEvents(events, NOW, 10).length, 1);
  });
});

describe('dedupeKey', () => {
  test('is stable for the same event and changes when it is rescheduled', () => {
    const original = eventAt(240);
    assert.equal(dedupeKey(original), dedupeKey(eventAt(240)));
    assert.notEqual(dedupeKey(original), dedupeKey(eventAt(900)));
  });
});

describe('formatMessage', () => {
  test('rounds minutes up so "4 min 10 s left" reads as 5', () => {
    assert.equal(minutesUntil(eventAt(250), NOW), 5);
    assert.equal(minutesUntil(eventAt(240), NOW), 4);
    assert.equal(minutesUntil(eventAt(5), NOW), 1);
  });

  test('shows title, local time range, location and links', () => {
    const text = formatMessage(
      eventAt(240, { location: 'Кабінет 5', hangoutLink: 'https://meet.google.com/abc-defg-hij' }),
      NOW,
      'Europe/Kyiv',
    );
    assert.match(text, /Через 4 хв/);
    assert.match(text, /<b>Планерка<\/b>/);
    assert.match(text, /12:04–12:34/); // 10:04Z is 12:04 in Kyiv (UTC+2 after the end of DST)
    assert.match(text, /📍 Кабінет 5/);
    assert.match(text, /href="https:\/\/meet\.google\.com\/abc-defg-hij"/);
    assert.match(text, /href="https:\/\/calendar\.google\.com\/calendar\/event\?eid=abc"/);
  });

  test('uses the requested time zone', () => {
    const text = formatMessage(eventAt(240), NOW, 'UTC');
    assert.match(text, /10:04–10:34/);
  });

  test('escapes HTML in user-provided fields', () => {
    const text = formatMessage(
      eventAt(240, { summary: '<b>R&D</b> "sync"', location: 'A & B <room>' }),
      NOW,
      'Europe/Kyiv',
    );
    assert.match(text, /<b>&lt;b&gt;R&amp;D&lt;\/b&gt; &quot;sync&quot;<\/b>/);
    assert.match(text, /📍 A &amp; B &lt;room&gt;/);
  });

  test('falls back to a placeholder title and omits missing optional lines', () => {
    const text = formatMessage(
      eventAt(240, { summary: undefined, htmlLink: undefined }),
      NOW,
      'Europe/Kyiv',
    );
    assert.match(text, /\(без назви\)/);
    assert.doesNotMatch(text, /📍|📹|🔗/);
  });
});
