import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The integrity gate (db:verify, the restore rehearsal) refuses to pass when fewer check rows come back than it
 * expects. That number lives in lib-db.sh, apart from the SQL file, so a damaged file cannot lower its own bar.
 * This test keeps the two honest: add a check to the SQL and you must raise the constant.
 */
describe('integrity checks definition', () => {
  const root = join(__dirname, '..', '..', 'scripts');
  const sql = readFileSync(join(root, 'sql', 'integrity-checks.sql'), 'utf8');
  const lib = readFileSync(join(root, 'lib-db.sh'), 'utf8');

  it('the SQL file and the expected count in lib-db.sh agree', () => {
    const defined = (sql.match(/SELECT '/g) ?? []).length;
    const expected = Number(/^INTEGRITY_EXPECTED_CHECKS=(\d+)$/m.exec(lib)?.[1]);
    expect(Number.isInteger(expected)).toBe(true);
    expect(defined).toBe(expected);
  });

  it('every check row is "<name>|<count>" and the file is one statement', () => {
    const code = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trimEnd();
    expect(code.endsWith(';')).toBe(true);
    expect(code.slice(0, -1)).not.toContain(';');
    for (const m of sql.matchAll(/SELECT '([^']*(?:''[^']*)*)\|'/g)) {
      expect(m[1].length).toBeGreaterThan(5);
    }
  });
});
