/**
 * The deployment promises that live in docker-compose.yml, checked as text so that deleting one is a failing
 * test and not a silent change. (The behaviour behind them is exercised by test/failure and docker:verify.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Full-line comments are dropped first: a promise that is only commented out must NOT satisfy these tests.
const compose = readFileSync(join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const service = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`service ${name} not found`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe('docker-compose.yml promises', () => {
  describe('postgres', () => {
    const pg = service('postgres');
    it('publishes only on loopback and declares memory and CPU limits', () => {
      expect(pg).toMatch(/127\.0\.0\.1:\$\{POSTGRES_PORT:-15432\}:5432/);
      expect(pg).toMatch(/mem_limit:\s*1g/);
      expect(pg).toMatch(/cpus:\s*1\.0/);
      expect(pg).toContain('restart: unless-stopped');
    });
  });

  describe('redis (optional queue)', () => {
    const redis = service('redis');
    it('is behind the "queue" profile so db:up never starts it', () => {
      expect(redis).toMatch(/profiles:\s*\["queue"\]/);
    });
    it('keeps queued jobs: noeviction + append-only file on a named volume', () => {
      expect(redis).toContain('--maxmemory-policy noeviction');
      expect(redis).toContain('--appendonly yes');
      expect(redis).toContain('--appendfsync always');
      expect(redis).toMatch(/redisdata:\/data/);
      expect(compose).toMatch(/\nvolumes:[\s\S]*redisdata:/);
    });
    it('is reachable from this machine only, bounded, and password-capable', () => {
      expect(redis).toMatch(/"127\.0\.0\.1:\$\{REDIS_PORT:-16379\}:6379"/);
      expect(redis).toMatch(/mem_limit:\s*384m/);
      expect(redis).toMatch(/cpus:\s*0\.5/);
      expect(redis).toContain('--requirepass');
      // the password is expanded by the container shell, never baked into the config by Compose
      expect(redis).toContain('$${REDIS_PASSWORD:+--requirepass "$$REDIS_PASSWORD"}');
    });
  });

  describe('app (server)', () => {
    const app = service('app');
    it('is hardened: read-only root, no capabilities, no-new-privileges, memory limit, no published port', () => {
      expect(app).toContain('read_only: true');
      expect(app).toMatch(/cap_drop:\s*\[ALL\]/);
      expect(app).toContain('no-new-privileges:true');
      expect(app).toMatch(/mem_limit:\s*1g/);
      expect(app).not.toMatch(/\n\s+ports:/);
    });
    it('passes every queue setting through, with the queue OFF by default', () => {
      expect(app).toContain('REDIS_URL: ${APP_REDIS_URL:-}');
      for (const key of [
        'REDIS_KEY_PREFIX',
        'REDIS_ALLOW_UNAUTHENTICATED',
        'REDIS_CONNECT_TIMEOUT_MS',
        'RECEIPT_WORKER_CONCURRENCY',
        'RECEIPT_JOB_ATTEMPTS',
        'RECEIPT_JOB_BACKOFF_SECONDS',
        'RECEIPT_JOB_TIMEOUT_SECONDS',
      ]) {
        expect(app).toContain(`${key}: `);
      }
      expect(app).toContain('REDIS_ALLOW_UNAUTHENTICATED: ${REDIS_ALLOW_UNAUTHENTICATED:-false}');
    });
  });
});
