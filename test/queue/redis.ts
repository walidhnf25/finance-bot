/** The Redis the queue suites use: the optional `queue` compose service, database 15 (never database 0). */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:16379/15';
