/**
 * Architecture rules, enforced by reading the source. They keep the layering from eroding silently:
 * the financial rules stay testable without Docker, a database, a network or the Telegram SDK.
 *
 *   domain          pure: no framework, no database client, no I/O, no infrastructure.
 *   application     talks to ports (abstract classes in the domain), never to Prisma, sharp, tesseract
 *                   or an HTTP client, and never to an infrastructure file.
 *   infrastructure  the only place adapters live. Another module may reach it only through its Nest module.
 *   shared          knows nothing about modules.
 *
 * A violation fails this test. A deliberate exception must be listed in EXCEPTIONS with a reason.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = __dirname;
const toPosix = (p: string): string => p.split('\\').join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Every `import ... from 'x'` / `export ... from 'x'` / `import('x')` target in a file. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

/** Resolve a relative or `src/...` import to a file under src, or null for a package. */
function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('.')
    ? resolve(dirname(from), spec)
    : spec.startsWith('src/')
      ? resolve(SRC, spec.slice(4))
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const rel = (file: string): string => toPosix(relative(SRC, file));
const layerOf = (file: string): 'domain' | 'application' | 'infrastructure' | 'other' => {
  const r = rel(file);
  if (/^modules\/[^/]+\/domain\//.test(r) || r.startsWith('shared/domain/')) return 'domain';
  if (/^modules\/[^/]+\/application\//.test(r)) return 'application';
  if (/^modules\/[^/]+\/infrastructure\//.test(r)) return 'infrastructure';
  return 'other';
};
const moduleOf = (file: string): string | null =>
  /^modules\/([^/]+)\//.exec(rel(file))?.[1] ?? null;

/** file -> reason. Keep this list short; every entry is a known deviation. */
const EXCEPTIONS: Record<string, string> = {};

const FILES = walk(SRC);
const violations = (check: (file: string, spec: string, target: string | null) => string | null) =>
  FILES.flatMap((file) =>
    importsOf(file)
      .map((spec) => check(file, spec, resolveLocal(file, spec)))
      .filter((v): v is string => v !== null)
      .map((v) => `${rel(file)}: ${v}`),
  ).filter((v) => !(v.split(':')[0] in EXCEPTIONS));

const FRAMEWORK = /^(@nestjs\/|@prisma\/|sharp$|tesseract\.js$|grammy|nestjs-pino|pino)/;
const NODE_IO = /^node:(fs|http|https|net|child_process|dns|tls|worker_threads)(\/.*)?$/;

describe('architecture', () => {
  it('finds source files to check (the rules below are not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(80);
    expect(FILES.filter((f) => layerOf(f) === 'domain').length).toBeGreaterThan(10);
    expect(FILES.filter((f) => layerOf(f) === 'application').length).toBeGreaterThan(5);
    expect(FILES.filter((f) => layerOf(f) === 'infrastructure').length).toBeGreaterThan(5);
  });

  it('the domain layer is pure: no framework, database client, I/O or infrastructure', () => {
    const found = violations((file, spec, target) => {
      if (layerOf(file) !== 'domain') return null;
      if (FRAMEWORK.test(spec)) return `imports the framework/library "${spec}"`;
      if (NODE_IO.test(spec)) return `imports node I/O "${spec}"`;
      if (target && layerOf(target) === 'infrastructure') return `imports infrastructure "${spec}"`;
      if (target && rel(target).startsWith('database/')) return `imports the database "${spec}"`;
      return null;
    });
    expect(found).toEqual([]);
  });

  it('the application layer never reaches Prisma, sharp, tesseract, node I/O or an infrastructure file', () => {
    const found = violations((file, spec, target) => {
      if (layerOf(file) !== 'application') return null;
      if (/^(@prisma\/|sharp$|tesseract\.js$|grammy)/.test(spec)) return `imports "${spec}"`;
      if (NODE_IO.test(spec)) return `imports node I/O "${spec}"`;
      if (target && layerOf(target) === 'infrastructure') return `imports infrastructure "${spec}"`;
      if (target && rel(target).startsWith('database/')) return `imports the database "${spec}"`;
      return null;
    });
    expect(found).toEqual([]);
  });

  it('another module reaches an infrastructure file only through a Nest module wiring file', () => {
    const found = violations((file, _spec, target) => {
      if (!target || layerOf(target) !== 'infrastructure') return null;
      if (file.endsWith('.module.ts')) return null;
      if (moduleOf(file) === moduleOf(target)) return null;
      return `imports ${rel(target)} from another module`;
    });
    expect(found).toEqual([]);
  });

  it('shared code knows nothing about the modules built on it', () => {
    const found = violations((file, _spec, target) => {
      if (!rel(file).startsWith('shared/')) return null;
      return target && rel(target).startsWith('modules/') ? `imports ${rel(target)}` : null;
    });
    expect(found).toEqual([]);
  });

  it('has no import cycle between source files', () => {
    const graph = new Map<string, string[]>();
    for (const file of FILES) {
      graph.set(
        file,
        importsOf(file)
          .map((spec) => resolveLocal(file, spec))
          .filter((t): t is string => t !== null && FILES.includes(t)),
      );
    }
    const state = new Map<string, 1 | 2>();
    const cycles: string[] = [];
    const visit = (file: string, stack: string[]): void => {
      state.set(file, 1);
      for (const next of graph.get(file) ?? []) {
        if (state.get(next) === 1) {
          cycles.push([...stack.slice(stack.indexOf(next)), file, next].map(rel).join(' -> '));
        } else if (!state.has(next)) {
          visit(next, [...stack, file]);
        }
      }
      state.set(file, 2);
    };
    for (const file of FILES) if (!state.has(file)) visit(file, []);
    expect(cycles).toEqual([]);
  });

  it('every listed exception still refers to a real file (the list cannot rot)', () => {
    for (const file of Object.keys(EXCEPTIONS)) {
      expect(existsSync(join(SRC, file))).toBe(true);
    }
  });
});
