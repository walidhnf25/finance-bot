/**
 * Static guard for tenant isolation. Every query a repository sends for user-owned data must mention the
 * owner (`userId`) in the same call. This reads the source, so it catches the mistake the behavioural
 * tests can only catch if someone thought to write that exact test: a new repository method that forgets
 * the ownership filter.
 *
 * It is a heuristic (it checks that the call text names the owner, not that the filter is correct), so it
 * complements the behavioural isolation tests (test/integration/isolation-probes.spec.ts) and the
 * mutation harness; it does not replace them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = __dirname;
const toPosix = (p: string): string => p.split('\\').join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Prisma delegates that hold one user's data. */
const OWNED = [
  'transaction',
  'transfer',
  'budget',
  'conversation',
  'receiptDraft',
  'category',
  'auditEvent',
];

/**
 * Calls that are legitimately not scoped to one user. Key: `file|model.operation`. Each needs a reason, and
 * the test fails if an entry no longer matches anything (the list cannot rot).
 */
const UNSCOPED: Record<string, string> = {
  'modules/retention/infrastructure/retention.service.ts|receiptDraft.updateMany':
    'retention is a system job: it acts on age/status for every user, never on money tables',
  'modules/retention/infrastructure/retention.service.ts|receiptDraft.deleteMany':
    'retention is a system job: it acts on age/status for every user, never on money tables',
  'modules/retention/infrastructure/retention.service.ts|auditEvent.deleteMany':
    'retention is a system job: removes audit rows older than the retention window for every user',
  'modules/retention/infrastructure/retention.service.ts|conversation.deleteMany':
    'retention is a system job: removes long-expired dialog state for every user',
};

interface Call {
  file: string;
  model: string;
  op: string;
  args: string;
  /** Text just before the call (to find a `const where = { userId, ... }` it refers to). */
  before: string;
  /** Whole file (to find a `data()` builder that sets the owner). */
  fileText: string;
}

/** Text between the parentheses of the call that starts at `open`, or null if unbalanced. */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function callsIn(file: string): Call[] {
  const text = readFileSync(file, 'utf8');
  const re = new RegExp(
    // any receiver at all (prisma, tx, this.prisma, a renamed client, a transaction handle...)
    `\\b((?:[A-Za-z_$][\\w$]*\\.)*)(${OWNED.join('|')})\\.(\\w+)\\(`,
    'g',
  );
  const out: Call[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // `this.conversation.getActive(` is a SERVICE called conversation, not the Prisma delegate: only
    // `this.prisma.<model>` counts among the `this.` receivers.
    const receiver = m[1];
    if (receiver.startsWith('this.') && !receiver.startsWith('this.prisma.')) continue;
    const args = balanced(text, m.index + m[0].length - 1);
    out.push({
      file: toPosix(relative(SRC, file)),
      model: m[2],
      op: m[3],
      args: args ?? '',
      before: text.slice(Math.max(0, m.index - 900), m.index),
      fileText: text,
    });
  }
  return out;
}

// EVERY non-spec source file, not only the repositories: a query written in a service, a controller or the
// importer must name its owner too.
const FILES = walk(SRC);
const CALLS = FILES.flatMap(callsIn);
// `userId: undefined` is no filter at all (Prisma drops it) and `select: { userId: true }` only reads the column.
const OWNER = /\buserId\b(?!\s*:\s*(?:undefined|true|false)\b)|\buser_id\b|\buserId_\w+|\buser\s*:/;

/**
 * Does this call name the owner? Directly in its arguments, or through one of the two idioms the
 * repositories use: a `where` variable declared just above with `userId`, or a `this.data(...)` builder
 * that sets `userId`.
 */
function namesOwner(c: Call): boolean {
  if (OWNER.test(c.args)) return true;
  const usesWhereVariable = /(^|[\s{,])where\s*[,}]/.test(c.args);
  if (usesWhereVariable && /const where\b[^=]*=\s*\{[^}]*\buserId\b/.test(c.before)) return true;
  if (/this\.data\(/.test(c.args) && /private data\([\s\S]{0,300}?\buserId:/.test(c.fileText))
    return true;
  return false;
}

describe('user scoping (static)', () => {
  it('finds the repository calls it is meant to check (the rule is not vacuous)', () => {
    expect(CALLS.length).toBeGreaterThan(40);
    for (const model of ['transaction', 'transfer', 'budget', 'receiptDraft']) {
      expect(CALLS.some((c) => c.model === model)).toBe(true);
    }
  });

  it('every query on user-owned data names the owner in the same call', () => {
    const unscoped = CALLS.filter((c) => !namesOwner(c))
      .filter((c) => !(`${c.file}|${c.model}.${c.op}` in UNSCOPED))
      .map((c) => `${c.file}: ${c.model}.${c.op}(…) has no userId`);
    expect(unscoped).toEqual([]);
  });

  it('every listed exception is still needed: it matches a call that really is unscoped', () => {
    const needed = new Set(
      CALLS.filter((c) => !namesOwner(c)).map((c) => `${c.file}|${c.model}.${c.op}`),
    );
    for (const key of Object.keys(UNSCOPED)) expect(needed).toContain(key);
  });

  it('raw SQL in repositories names the owner, or is on the reviewed list', () => {
    const RAW = /\$(?:queryRaw|executeRaw)(?:Unsafe)?\s*[`(]/g;
    const REVIEWED: Record<string, string> = {
      'database/prisma.service.ts': 'connectivity ping: SELECT 1',
      'modules/health/health.service.ts': 'reads _prisma_migrations, no user data',
    };
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const rel = toPosix(relative(SRC, file));
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = RAW.exec(text))) {
        const window = text.slice(m.index, m.index + 600);
        if (!/user_id|userId/.test(window) && !(rel in REVIEWED)) {
          found.push(`${rel}: raw SQL without an owner filter`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
