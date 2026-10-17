#!/usr/bin/env node
/**
 * Read-only look at the optional background queues: how many jobs wait, run or have failed, and why the
 * failed ones failed. It never prints a job's payload (ids, file ids) and never changes anything.
 *
 *   npm run queue:status
 *
 * Reads REDIS_URL and REDIS_KEY_PREFIX from the environment or .env. Exit 0 = reachable, 1 = Redis is
 * unreachable, 2 = queues are off (REDIS_URL empty).
 */
require('dotenv/config');
const { Queue } = require('bullmq');

const url = process.env.REDIS_URL || '';
if (!url) {
  console.log('queues are off: REDIS_URL is empty (receipt photos are read in-process).');
  process.exit(2);
}
const u = new URL(url);
const prefix = `${process.env.REDIS_KEY_PREFIX || 'finance-bot:'}bull`;
const connection = {
  host: u.hostname.replace(/^\[|\]$/g, ''),
  port: Number(u.port || '6379'),
  db: Number(u.pathname.replace('/', '') || '0') || 0,
  username: u.username ? decodeURIComponent(u.username) : undefined,
  password: u.password ? decodeURIComponent(u.password) : undefined,
  tls: u.protocol === 'rediss:' ? {} : undefined,
  connectTimeout: 2000,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
};

const within = (work, ms) =>
  Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

(async () => {
  let code = 0;
  for (const name of ['receipts', 'maintenance']) {
    const queue = new Queue(name, { connection, prefix });
    queue.on('error', () => undefined);
    try {
      const counts = await within(
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
        4000,
      );
      console.log(`${name.padEnd(12)} ${JSON.stringify(counts)}`);
      const failed = await within(queue.getFailed(0, 19), 4000);
      for (const job of failed) {
        const when = job.finishedOn ? new Date(job.finishedOn).toISOString() : '-';
        const reason = String(job.failedReason || '')
          .replace(/\s+/g, ' ')
          .slice(0, 120);
        console.log(
          `  FAILED ${job.id}  job=${job.name} attempts=${job.attemptsMade} at=${when}  ${reason}`,
        );
      }
    } catch {
      console.error(`${name}: Redis is not reachable`);
      code = 1;
    } finally {
      // an unreachable Redis can make disconnect() wait for a connection that never comes
      await within(queue.disconnect(), 1000).catch(() => undefined);
    }
  }
  process.exit(code);
})();
