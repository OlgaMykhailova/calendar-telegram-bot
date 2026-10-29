const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Telegram asks to wait `retry_after` seconds on 429; longer waits are not worth holding a cron run for.
const MAX_RETRY_AFTER_SECONDS = 15;

export async function sendMessage(
  env,
  text,
  { fetchFn = fetch, sleepFn = sleep, maxAttempts = 3 } = {},
) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const redact = (message) => String(message).replaceAll(token, '<token>');

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      lastError = new Error(`Telegram request failed: ${redact(err?.message)}`);
      await sleepFn(1000 * attempt);
      continue;
    }
    if (res.ok) return;

    const body = await res.json().catch(() => ({}));
    lastError = new Error(
      `Telegram sendMessage failed: ${res.status} ${redact(body.description ?? res.statusText)}`,
    );

    const retryAfter = body.parameters?.retry_after;
    if (res.status === 429 && retryAfter != null && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
      await sleepFn(retryAfter * 1000);
    } else if (res.status >= 500) {
      await sleepFn(1000 * attempt);
    } else {
      throw lastError; // other 4xx (bad token, unknown chat): retrying will not help
    }
  }
  throw lastError;
}
