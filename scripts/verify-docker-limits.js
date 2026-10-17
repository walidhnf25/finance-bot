#!/usr/bin/env node
/**
 * Compares what docker-compose.yml DECLARES with what the running containers actually HAVE.
 * A limit written in the Compose file does nothing for a container that was created before the limit was
 * added: only `docker inspect` shows what is in force. Read-only: it never starts, stops or recreates anything.
 *
 *   npm run docker:verify                          the always-on stack (PostgreSQL)
 *   COMPOSE_PROFILES=app npm run docker:verify     also the bot container (on a server)
 *
 * Exit 0 = every declared limit and hardening setting is active, 1 = a mismatch, 2 = cannot check.
 * It also fails when a container publishes a port on a non-loopback address.
 */
const { execFileSync } = require('node:child_process');
const { evaluateService } = require('./docker-limits-lib');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let config;
try {
  config = JSON.parse(run('docker', ['compose', 'config', '--format', 'json']));
} catch (e) {
  console.error('cannot read the Compose configuration:', String(e.message).split('\n')[0]);
  process.exit(2);
}

let failed = 0;
const rows = [];
for (const [service, def] of Object.entries(config.services ?? {})) {
  if (!def.container_name) continue; // one-shot services (migrate) have no fixed name
  let inspect;
  try {
    inspect = JSON.parse(run('docker', ['inspect', def.container_name]))[0];
  } catch {
    rows.push({
      service,
      name: def.container_name,
      check: 'container',
      declared: 'exists',
      active: 'NOT FOUND',
      ok: false,
    });
    failed++;
    continue;
  }
  for (const row of evaluateService(service, def, inspect)) {
    if (!row.ok) failed++;
    rows.push(row);
  }
}

for (const r of rows) {
  console.log(
    `${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(18)} ${r.check.padEnd(22)} declared=${r.declared}  active=${r.active}`,
  );
}
if (failed > 0) {
  console.error(
    `\n${failed} mismatch(es). A container created before its limits were declared keeps running without them.\n` +
      'Recreate ONLY the affected service, keeping its volume (never "down -v"):  docker compose up -d <service>\n' +
      'The database restarts for a few seconds; take a backup first (npm run db:backup).',
  );
  process.exit(1);
}
console.log('\nevery declared limit and hardening setting is active on the running containers');
