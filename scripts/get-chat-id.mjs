// Prints the chats that have recently written to the bot, so you can pick TELEGRAM_CHAT_ID.
// Usage: put TELEGRAM_BOT_TOKEN in .dev.vars, message the bot, then run `npm run get-chat-id`.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Не задано TELEGRAM_BOT_TOKEN. Скопіюйте .dev.vars.example у .dev.vars і впишіть токен бота.');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const body = await res.json().catch(() => ({}));
if (!body.ok) {
  console.error(`Telegram повернув помилку: ${res.status} ${body.description ?? res.statusText}`);
  process.exit(1);
}

const chats = new Map();
for (const update of body.result) {
  const chat = (update.message ?? update.edited_message ?? update.channel_post ?? update.my_chat_member)?.chat;
  if (chat) chats.set(chat.id, chat);
}

if (chats.size === 0) {
  console.log('Оновлень немає. Напишіть боту будь-яке повідомлення (або додайте його в групу й напишіть там) і запустіть команду ще раз.');
} else {
  console.log('chat_id\tтип\tназва');
  for (const chat of chats.values()) {
    console.log(`${chat.id}\t${chat.type}\t${chat.title ?? chat.username ?? chat.first_name ?? ''}`);
  }
}
