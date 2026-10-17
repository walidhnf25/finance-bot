/**
 * Pure comparison logic for `npm run docker:verify`: what docker-compose.yml DECLARES versus what
 * `docker inspect` says a container actually HAS. No I/O here, so it is unit-tested with fixtures
 * (src/ops/docker-limits.spec.ts).
 */

const LOOPBACK = new Set(['127.0.0.1', '::1']);

/**
 * @param {string} service  compose service name
 * @param {object} def      the service as printed by `docker compose config --format json`
 * @param {object} inspect  the first element of `docker inspect <container>`
 * @returns {Array<{service:string,name:string,check:string,declared:string,active:string,ok:boolean}>}
 */
function evaluateService(service, def, inspect) {
  const name = def.container_name;
  const host = inspect.HostConfig ?? {};
  const rows = [];
  const add = (check, declared, active, ok = String(declared) === String(active)) =>
    rows.push({ service, name, check, declared: String(declared), active: String(active), ok });

  // ---- resource limits (a limit declared after the container was created is NOT in force)
  const wantMem = def.mem_limit ? Number(def.mem_limit) : 0;
  const wantNano = def.cpus ? Math.round(Number(def.cpus) * 1e9) : 0;
  add('memory (bytes)', wantMem, host.Memory ?? 0);
  add('cpus (nano)', wantNano, host.NanoCpus ?? 0);
  add('restart policy', def.restart ?? 'no', host.RestartPolicy?.Name || 'no');

  // ---- hardening that is declared must be in force
  if (def.read_only) add('read-only root fs', 'true', String(Boolean(host.ReadonlyRootfs)));
  if (Array.isArray(def.cap_drop) && def.cap_drop.includes('ALL')) {
    add(
      'capabilities dropped',
      'ALL',
      (host.CapDrop ?? []).join(',') || 'none',
      (host.CapDrop ?? []).includes('ALL'),
    );
  }
  if ((def.security_opt ?? []).some((o) => String(o).startsWith('no-new-privileges'))) {
    const active = (host.SecurityOpt ?? []).some((o) => String(o).startsWith('no-new-privileges'));
    add('no-new-privileges', 'true', String(active), active);
  }

  // ---- nothing may listen on a non-loopback address of the host
  const ports = inspect.NetworkSettings?.Ports ?? {};
  const exposed = [];
  for (const [containerPort, bindings] of Object.entries(ports)) {
    for (const b of bindings ?? []) {
      if (!LOOPBACK.has(b.HostIp))
        exposed.push(`${b.HostIp || '0.0.0.0'}:${b.HostPort}->${containerPort}`);
    }
  }
  add(
    'published ports',
    'loopback only',
    exposed.length ? exposed.join(' ') : 'loopback only',
    exposed.length === 0,
  );

  // ---- state
  const state = inspect.State?.Health?.Status ?? inspect.State?.Status;
  add('state', 'healthy/running', state, ['healthy', 'running'].includes(state));
  return rows;
}

module.exports = { evaluateService };
