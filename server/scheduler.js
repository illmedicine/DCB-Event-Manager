const db = require('../discord-crypto-task-payroll-bot/utils/db');

module.exports = function startScheduler(client) {
  const processDuePosts = async () => {
    try {
      const due = await db.getDueScheduledPosts();
      for (const post of due) {
        try {
          const channel = await client.channels.fetch(post.channel_id);
          if (!channel) {
            await db.updateScheduledPostStatus(post.id, 'failed');
            continue;
          }
          const msg = await channel.send({ content: post.content });
          await db.updateScheduledPostStatus(post.id, 'sent', msg.id);
        } catch (e) {
          console.error('[Scheduler] Error publishing scheduled post', e.message);
          await db.updateScheduledPostStatus(post.id, 'failed');
        }
      }
    } catch (e) {
      console.error('[Scheduler] Error fetching due posts', e.message);
    }
  };

  // Run every minute
  setInterval(processDuePosts, 60 * 1000);

  // Run on startup
  processDuePosts();
};