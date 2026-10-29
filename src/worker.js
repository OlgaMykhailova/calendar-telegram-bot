import { runReminderJob } from './job.js';

export default {
  async scheduled(_controller, env) {
    const sent = await runReminderJob(env);
    if (sent.length) console.log(`Sent ${sent.length} reminder(s) for: ${sent.join(', ')}`);
  },
};
