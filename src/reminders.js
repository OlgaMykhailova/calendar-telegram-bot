const MINUTE_MS = 60_000;

/**
 * Events that should be announced right now: timed (not all-day), not cancelled,
 * and starting within the next `reminderMinutes` (but not yet started).
 * Several cron runs fall into this window, so callers must deduplicate.
 */
export function findDueEvents(events, now, reminderMinutes) {
  const nowMs = now.getTime();
  return events.filter((event) => {
    if (event.status === 'cancelled') return false;
    const startIso = event.start?.dateTime; // all-day events only have `date`
    if (!startIso) return false;
    const untilStart = Date.parse(startIso) - nowMs;
    return untilStart > 0 && untilStart <= reminderMinutes * MINUTE_MS;
  });
}

/**
 * A rescheduled event gets a new start time and therefore a new key,
 * so it is announced again.
 */
export function dedupeKey(event) {
  return `sent:${event.id}:${event.start.dateTime}`;
}

export function minutesUntil(event, now) {
  return Math.max(1, Math.ceil((Date.parse(event.start.dateTime) - now.getTime()) / MINUTE_MS));
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso, timeZone) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Telegram message text (parse_mode HTML). */
export function formatMessage(event, now, timeZone) {
  const minutes = minutesUntil(event, now);
  const title = escapeHtml(event.summary?.trim() || '(без назви)');
  const start = formatTime(event.start.dateTime, timeZone);
  const end = event.end?.dateTime ? formatTime(event.end.dateTime, timeZone) : null;

  const lines = [
    `⏰ <b>Через ${minutes} хв</b>`,
    `<b>${title}</b>`,
    `🕐 ${end ? `${start}–${end}` : start}`,
  ];
  if (event.location) lines.push(`📍 ${escapeHtml(event.location)}`);
  if (event.hangoutLink) lines.push(`📹 <a href="${escapeHtml(event.hangoutLink)}">Google Meet</a>`);
  if (event.htmlLink) lines.push(`🔗 <a href="${escapeHtml(event.htmlLink)}">Відкрити в календарі</a>`);
  return lines.join('\n');
}
