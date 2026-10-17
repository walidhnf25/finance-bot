/**
 * The comparison logic behind `npm run docker:verify`, tested with fixtures shaped like `docker inspect`.
 * The point of the script is to catch a limit that is DECLARED but not IN FORCE, so these tests make sure it
 * actually fails in exactly those situations.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluateService } = require('../../scripts/docker-limits-lib.js') as {
  evaluateService: (
    service: string,
    def: Record<string, unknown>,
    inspect: Record<string, unknown>,
  ) => Array<{ check: string; ok: boolean; declared: string; active: string }>;
};

const DEF = {
  container_name: 'finance-bot-postgres',
  mem_limit: '1073741824',
  cpus: 1,
  restart: 'unless-stopped',
};
const healthy = {
  HostConfig: {
    Memory: 1073741824,
    NanoCpus: 1_000_000_000,
    RestartPolicy: { Name: 'unless-stopped' },
  },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }] } },
  State: { Status: 'running', Health: { Status: 'healthy' } },
};
const failing = (rows: Array<{ ok: boolean; check: string }>) =>
  rows.filter((r) => !r.ok).map((r) => r.check);

describe('docker limits verifier', () => {
  it('passes when every declared limit is in force', () => {
    expect(failing(evaluateService('postgres', DEF, healthy))).toEqual([]);
  });

  it('fails a container created BEFORE its limits were declared (memory and cpu are 0)', () => {
    const legacy = { ...healthy, HostConfig: { ...healthy.HostConfig, Memory: 0, NanoCpus: 0 } };
    expect(failing(evaluateService('postgres', DEF, legacy))).toEqual([
      'memory (bytes)',
      'cpus (nano)',
    ]);
  });

  it('fails a wrong limit and a wrong restart policy', () => {
    const wrong = {
      ...healthy,
      HostConfig: { ...healthy.HostConfig, Memory: 536870912, RestartPolicy: { Name: 'no' } },
    };
    expect(failing(evaluateService('postgres', DEF, wrong))).toEqual([
      'memory (bytes)',
      'restart policy',
    ]);
  });

  it('fails a database published on every network interface (the dangerous default)', () => {
    for (const hostIp of ['', '0.0.0.0', '::', '192.168.1.5']) {
      const open = {
        ...healthy,
        NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: hostIp, HostPort: '5432' }] } },
      };
      expect(failing(evaluateService('postgres', DEF, open))).toEqual(['published ports']);
    }
  });

  it('accepts loopback bindings on IPv4 and IPv6, and a container that publishes nothing', () => {
    const both = {
      ...healthy,
      NetworkSettings: {
        Ports: {
          '5432/tcp': [
            { HostIp: '127.0.0.1', HostPort: '1' },
            { HostIp: '::1', HostPort: '1' },
          ],
        },
      },
    };
    expect(failing(evaluateService('postgres', DEF, both))).toEqual([]);
    expect(
      failing(evaluateService('postgres', DEF, { ...healthy, NetworkSettings: { Ports: {} } })),
    ).toEqual([]);
    expect(
      failing(
        evaluateService('postgres', DEF, {
          ...healthy,
          NetworkSettings: { Ports: { '3000/tcp': null } },
        }),
      ),
    ).toEqual([]);
  });

  it('fails a container that is not healthy', () => {
    const sick = { ...healthy, State: { Status: 'running', Health: { Status: 'unhealthy' } } };
    expect(failing(evaluateService('postgres', DEF, sick))).toEqual(['state']);
  });

  describe('hardening declared for the bot container', () => {
    const app = {
      container_name: 'finance-bot-app',
      restart: 'unless-stopped',
      mem_limit: '1073741824',
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
    };
    const hardened = {
      HostConfig: {
        Memory: 1073741824,
        NanoCpus: 0,
        RestartPolicy: { Name: 'unless-stopped' },
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
      },
      NetworkSettings: { Ports: {} },
      State: { Status: 'running', Health: { Status: 'healthy' } },
    };

    it('passes a container that really is hardened', () => {
      expect(failing(evaluateService('app', app, hardened))).toEqual([]);
    });

    it('fails each missing protection separately', () => {
      expect(
        failing(
          evaluateService('app', app, {
            ...hardened,
            HostConfig: { ...hardened.HostConfig, ReadonlyRootfs: false },
          }),
        ),
      ).toEqual(['read-only root fs']);
      expect(
        failing(
          evaluateService('app', app, {
            ...hardened,
            HostConfig: { ...hardened.HostConfig, CapDrop: [] },
          }),
        ),
      ).toEqual(['capabilities dropped']);
      expect(
        failing(
          evaluateService('app', app, {
            ...hardened,
            HostConfig: { ...hardened.HostConfig, SecurityOpt: [] },
          }),
        ),
      ).toEqual(['no-new-privileges']);
    });

    it('does not demand hardening that was never declared', () => {
      const plain = { container_name: 'x', restart: 'no' };
      const bare = { HostConfig: {}, NetworkSettings: { Ports: {} }, State: { Status: 'running' } };
      expect(failing(evaluateService('x', plain, bare))).toEqual([]);
    });
  });
});
