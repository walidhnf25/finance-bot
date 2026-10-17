import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A receipt photo contains personal data, so the receipt pipeline must keep it in memory: it is never
 * written to disk, not even temporarily. This guard fails if code in the runtime receipt module starts
 * using a file-writing API. (The evaluation harness and live-check are developer tools and excluded.)
 */
const FILE_WRITING_APIS =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdtemp|mkdtempSync|copyFile|copyFileSync|renameSync|rename|mkdirSync)\b|\.toFile\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'evaluation' ? [] : sources(full);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) && name !== 'live-check.ts'
      ? [full]
      : [];
  });
}

describe('receipt module', () => {
  it('never writes receipt images or text to disk', () => {
    const offenders = sources(__dirname).filter((file) =>
      FILE_WRITING_APIS.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(__dirname, ''))).toEqual([]);
  });

  it('the guard itself works: it would flag a file that writes', () => {
    expect(FILE_WRITING_APIS.test("import { writeFileSync } from 'node:fs';")).toBe(true);
    expect(FILE_WRITING_APIS.test('await sharp(buf).toFile("x.png")')).toBe(true);
    expect(FILE_WRITING_APIS.test("import { existsSync } from 'node:fs';")).toBe(false);
  });
});
