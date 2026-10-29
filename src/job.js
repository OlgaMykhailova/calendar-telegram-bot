import { listUpcomingEvents } from './google.js';
import { dedupeKey, findDueEvents, formatMessage } from './reminders.js';
import { sendMessage } from './telegram.js';

// An announced event stops being "due" once it starts, so a few hours is plenty.
const SENT_TTL_SECONDS = 6 * 60 * 60;

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GOOGLE_CALENDAR_ID', 'GOOGLE_SERVICE_ACCOUNT_KEY'];

export function readConfig(env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (!env.STATE) missing.push('STATE (KV binding)');
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);

  const reminderMinutes = Number(env.REMINDER_MINUTES ?? 5);
  if (!Number.isFinite(reminderMinutes) || reminderMinutes <= 0) {
    throw new Error(`REMINDER_MINUTES must be a positive number, got "${env.REMINDER_MINUTES}"`);
  }
  return { reminderMinutes, timeZone: env.TIMEZONE || 'Europe/Kyiv' };
}

/**
 * One cron run: fetch upcoming events, announce the ones that are due and not yet announced.
 * Returns the ids of events a reminder was sent for.
 */
export async function runReminderJob(env, { now = new Date(), fetchFn = fetch, sleepFn } = {}) {
  const { reminderMinutes, timeZone } = readConfig(env);

  const events = await listUpcomingEvents(env, { now, windowMinutes: reminderMinutes, fetchFn });
  const sent = [];
  const failures = [];

  for (const event of findDueEvents(events, now, reminderMinutes)) {
    const key = dedupeKey(event);
    if (await env.STATE.get(key)) continue;

    // Claim before sending so an overlapping run cannot send it twice;
    // release on failure so the next minute tries again instead of losing the reminder.
    await env.STATE.put(key, now.toISOString(), { expirationTtl: SENT_TTL_SECONDS });
    try {
      await sendMessage(env, formatMessage(event, now, timeZone), { fetchFn, sleepFn });
      sent.push(event.id);
    } catch (err) {
      await env.STATE.delete(key);
      failures.push(err);
    }
  }

  // Fail the invocation (visible in the dashboard and `wrangler tail`) after trying every event.
  if (failures.length) throw failures[0];
  return sent;
}
