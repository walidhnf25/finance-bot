/**
 * Repeatable receipt extraction evaluation (OCR + parsing), run locally.
 *
 *   npm run receipt:eval                         synthetic set, OCR + deterministic parser
 *   npm run receipt:eval -- --with-model         also the Ollama model (slow: ~20-30 s per image)
 *   npm run receipt:eval -- --dir D:\receipts    your own images: x.jpg + x.json {"total":875000,"date":"2019-11-16","merchant":"..."}
 *   npm run receipt:eval -- --only thermal       one variant; --limit 10 first ten cases
 *   npm run receipt:eval -- --save-images out    write the generated PNG/JPEG files to inspect them
 *
 * Nothing is uploaded anywhere and nothing is stored in the database. Private images given with
 * --dir must never be committed; reports go to evaluation-reports/ (git-ignored) and contain case ids,
 * not receipt text. Scoring separates OCR errors (the true total's digits are not in the OCR text)
 * from parsing errors (they are there, but the wrong number was chosen).
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ReceiptExtractor } from '../application/receipt-extractor';
import { findDate } from '../domain/heuristic-extractor';
import { deterministicExtract, readReceiptText } from '../application/receipt-reader';
import { numbersInText, ReceiptExtraction } from '../domain/receipt-extraction';
import {
  enhanceForOcr,
  prepareImage,
  SharpImageProcessor,
} from '../infrastructure/image-processor';
import { ReceiptOcr, TesseractOcr } from '../infrastructure/ocr';
import { OllamaClient } from '../infrastructure/ollama.client';
import { buildCases, renderCase, Variant } from './synthetic-receipts';

interface Truth {
  total: number | null;
  date: string | null;
  merchant: string | null;
  unscored?: Array<'date' | 'merchant'>;
}
interface EvalCase {
  id: string;
  tag: string;
  variant: string;
  image: Buffer;
  truth: Truth;
}
type Mode = 'deterministic' | 'model';
interface Outcome {
  declined: boolean;
  extraction: ReceiptExtraction | null;
  ms: number;
}
interface CaseResult {
  id: string;
  variant: string;
  tag: string;
  ocrMs: number;
  ocrHasTrueTotal: boolean | null;
  ocrDate: string | null;
  outcomes: Partial<Record<Mode, Outcome>>;
}

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const normalize = (t: string): string => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x.includes(y) || y.includes(x)) return 1;
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [
    i,
    ...new Array<number>(y.length).fill(0),
  ]);
  for (let j = 0; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
  return 1 - d[x.length][y.length] / Math.max(x.length, y.length);
}

function loadPrivate(dir: string): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const file of readdirSync(dir)) {
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extname(file).toLowerCase())) continue;
    const sidecar = join(dir, file.replace(/\.[^.]+$/, '.json'));
    if (!existsSync(sidecar)) {
      console.log(`skipping ${file}: no ${file.replace(/\.[^.]+$/, '.json')} with the true values`);
      continue;
    }
    const truth = JSON.parse(readFileSync(sidecar, 'utf8')) as Truth;
    cases.push({
      id: `private:${file}`,
      tag: 'your own image',
      variant: 'private',
      image: readFileSync(join(dir, file)),
      truth,
    });
  }
  return cases;
}

async function main(): Promise<void> {
  const ctx = {
    // After every date used by the synthetic receipts, so none of them is "in the future".
    now: new Date('2027-01-15T05:00:00Z'),
    timezone: 'Asia/Jakarta',
  };
  let cases: EvalCase[];
  const privateDir = value('dir');
  if (privateDir) {
    cases = loadPrivate(privateDir);
  } else {
    cases = [];
    for (const c of buildCases()) {
      cases.push({
        id: c.id,
        tag: c.tag,
        variant: c.variant,
        image: await renderCase(c),
        truth: c.truth,
      });
    }
  }
  const only = value('only') as Variant | undefined;
  if (only) cases = cases.filter((c) => c.variant === only);
  const limit = Number(value('limit') ?? 0);
  if (limit > 0) cases = cases.slice(0, limit);
  if (cases.length === 0) throw new Error('No cases to evaluate.');

  const saveDir = value('save-images');
  if (saveDir) {
    mkdirSync(saveDir, { recursive: true });
    cases.forEach((c, i) =>
      writeFileSync(
        join(saveDir, `${String(i).padStart(2, '0')}-${c.id.replace(/[^A-Za-z0-9-]/g, '_')}.bin`),
        c.image,
      ),
    );
  }

  const ocr = new TesseractOcr();
  const withModel = flag('with-model');
  const ollama = new OllamaClient({
    provider: withModel ? 'ollama' : 'none',
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL ?? '',
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000),
    maxResponseBytes: 1_048_576,
  });
  let modelName = '(not used)';
  if (withModel) {
    const health = await ollama.check();
    if (!health.available) throw new Error(`Ollama is not usable: ${health.detail}`);
    modelName = await ollama.resolveModel();
  }

  const results: CaseResult[] = [];
  let n = 0;
  for (const c of cases) {
    n += 1;
    process.stdout.write(`\r[${n}/${cases.length}] ${c.id.padEnd(40)}`);
    const image = await prepareImage(c.image, { maxBytes: 20 * 1_048_576, maxPixels: 50_000_000 });
    // Same code the bot runs: OCR (second pass only if the first found no usable total), then the
    // deterministic reader.
    const t0 = Date.now();
    const text = await readReceiptText(image, ocr, (png) => enhanceForOcr(png));
    const ocrMs = Date.now() - t0;

    const result: CaseResult = {
      id: c.id,
      variant: c.variant,
      tag: c.tag,
      ocrMs,
      ocrHasTrueTotal: c.truth.total === null ? null : numbersInText(text).has(c.truth.total),
      ocrDate: findDate(text),
      outcomes: {},
    };

    const t1 = Date.now();
    const detExtraction = deterministicExtract(text, ctx);
    const det: Outcome = {
      declined: detExtraction === null,
      extraction: detExtraction,
      ms: Date.now() - t1,
    };
    result.outcomes.deterministic = det;

    if (withModel) {
      const cached: ReceiptOcr = { read: () => Promise.resolve(text) };
      const t2 = Date.now();
      try {
        const { extraction } = await new ReceiptExtractor(
          cached,
          ollama,
          'always',
          new SharpImageProcessor(),
        ).extract(image, ctx);
        result.outcomes.model = { declined: false, extraction, ms: Date.now() - t2 };
      } catch {
        result.outcomes.model = { declined: true, extraction: null, ms: Date.now() - t2 };
      }
    }
    results.push(result);
  }
  process.stdout.write('\n');
  await ocr.onModuleDestroy();

  report(cases, results, modelName, Boolean(privateDir));
}

// Warnings that tell the user to double-check the total (so a wrong total is not a silent one).
const TOTAL_FLAGS = new Set([
  'TOTAL_NOT_IN_TEXT',
  'ITEMS_DO_NOT_ADD_UP',
  'TOTAL_CONFLICTS_WITH_PAYMENT',
  'TOTAL_DISPUTED',
  'TOTAL_DERIVED',
  'TOTAL_UNLABELLED',
  'TOTAL_AMBIGUOUS',
]);

function score(cases: EvalCase[], results: CaseResult[], mode: Mode) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  let totalCases = 0,
    totalOk = 0,
    declinedCorrectly = 0,
    noTotalCases = 0;
  let falseDrafts = 0,
    silentFalse = 0,
    flaggedFalse = 0,
    ocrErrors = 0,
    parserErrors = 0,
    missedTotals = 0;
  let dateCases = 0,
    dateOk = 0,
    dateSilentWrong = 0,
    merchantCases = 0,
    merchantOk = 0;
  const ms: number[] = [];
  for (const r of results) {
    const c = byId.get(r.id)!;
    const o = r.outcomes[mode];
    if (!o) continue;
    ms.push(o.ms);
    const ex = o.extraction;
    const truth = c.truth;
    if (truth.total !== null) {
      totalCases += 1;
      if (ex && ex.total === truth.total) totalOk += 1;
      else if (ex) {
        parserErrors += r.ocrHasTrueTotal ? 1 : 0;
        ocrErrors += r.ocrHasTrueTotal ? 0 : 1;
      } else {
        missedTotals += 1;
        ocrErrors += r.ocrHasTrueTotal ? 0 : 1;
        parserErrors += r.ocrHasTrueTotal ? 1 : 0;
      }
    } else {
      noTotalCases += 1;
      if (!ex) declinedCorrectly += 1;
    }
    if (ex && ex.total !== truth.total) {
      falseDrafts += 1;
      if (ex.warnings.some((w) => TOTAL_FLAGS.has(w))) flaggedFalse += 1;
      else silentFalse += 1;
    }
    if (truth.date && !truth.unscored?.includes('date') && ex) {
      dateCases += 1;
      if (ex && ex.date === truth.date) dateOk += 1;
      else if (ex && ex.date && !ex.warnings.some((w) => w.startsWith('DATE_')))
        dateSilentWrong += 1;
    }
    if (truth.merchant && !truth.unscored?.includes('merchant')) {
      merchantCases += 1;
      if (ex?.merchant && similarity(ex.merchant, truth.merchant) >= 0.8) merchantOk += 1;
    }
  }
  const pct = (a: number, b: number): string =>
    b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(0)}% (${a}/${b})`;
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    totalExact: pct(totalOk, totalCases),
    totalMissed: `${missedTotals}/${totalCases}`,
    ambiguousHandledByDeclining: pct(declinedCorrectly, noTotalCases),
    falseDraftRate: pct(falseDrafts, results.length),
    silentFalseDrafts: `${silentFalse}`,
    flaggedFalseDrafts: `${flaggedFalse}`,
    ocrErrors,
    parserErrors,
    dateExact: pct(dateOk, dateCases),
    dateSilentWrong,
    merchantMatch: pct(merchantOk, merchantCases),
    medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    p95Ms: sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      : 0,
  };
}

function report(
  cases: EvalCase[],
  results: CaseResult[],
  modelName: string,
  isPrivate: boolean,
): void {
  const modes: Mode[] = results.some((r) => r.outcomes.model)
    ? ['deterministic', 'model']
    : ['deterministic'];
  const ocrMs = results.map((r) => r.ocrMs).sort((a, b) => a - b);
  const summary: Record<string, unknown> = {
    at: new Date().toISOString(),
    set: isPrivate
      ? 'private images (not reproducible by others)'
      : 'synthetic (generated, deterministic)',
    images: results.length,
    variants: [...new Set(results.map((r) => r.variant))],
    ocrEngine: 'tesseract.js 6, languages ind+eng',
    model: modelName,
    ocrMedianMs: ocrMs[Math.floor(ocrMs.length / 2)],
    ocrP95Ms: ocrMs[Math.min(ocrMs.length - 1, Math.floor(ocrMs.length * 0.95))],
  };
  for (const m of modes) summary[m] = score(cases, results, m);

  console.log('\n=== Receipt extraction evaluation ===');
  console.log(
    `Images: ${results.length} (${summary.set as string}); variants: ${(summary.variants as string[]).join(', ')}`,
  );
  console.log(
    `OCR: ${summary.ocrEngine as string}; median ${summary.ocrMedianMs as number} ms, p95 ${summary.ocrP95Ms as number} ms`,
  );
  for (const m of modes) {
    console.log(`\n[${m}${m === 'model' ? ` - ${modelName}` : ''}]`);
    for (const [k, v] of Object.entries(summary[m] as Record<string, unknown>))
      console.log(`  ${k.padEnd(28)} ${String(v)}`);
  }

  // Per-variant total accuracy for the deterministic path, and every wrong/missed case by id.
  console.log('\nTotal accuracy by variant (deterministic):');
  for (const variant of summary.variants as string[]) {
    const sub = results.filter((r) => r.variant === variant);
    const withTruth = sub.filter((r) => cases.find((c) => c.id === r.id)!.truth.total !== null);
    const ok = withTruth.filter(
      (r) =>
        r.outcomes.deterministic?.extraction?.total ===
        cases.find((c) => c.id === r.id)!.truth.total,
    ).length;
    console.log(`  ${variant.padEnd(14)} ${ok}/${withTruth.length}`);
  }
  console.log('\nCases not handled correctly (deterministic):');
  for (const r of results) {
    const c = cases.find((x) => x.id === r.id)!;
    const ex = r.outcomes.deterministic?.extraction ?? null;
    const wrong = c.truth.total === null ? ex !== null : ex?.total !== c.truth.total;
    if (!wrong) continue;
    const got = ex
      ? `got ${ex.total}${ex.warnings.length ? ` [${ex.warnings.join(',')}]` : ' [NO WARNING]'}`
      : 'declined';
    const why =
      c.truth.total === null
        ? 'expected: decline or warn'
        : r.ocrHasTrueTotal
          ? 'OCR had the digits -> parser error'
          : 'OCR missed the digits -> OCR error';
    console.log(
      `  ${r.id.padEnd(34)} want ${String(c.truth.total).padEnd(8)} ${got.padEnd(40)} ${why}`,
    );
  }

  mkdirSync('evaluation-reports', { recursive: true });
  const file = join(
    'evaluation-reports',
    `receipt-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        summary,
        cases: results.map((r) => ({
          id: r.id,
          variant: r.variant,
          ocrHasTrueTotal: r.ocrHasTrueTotal,
          ocrMs: r.ocrMs,
          deterministic: r.outcomes.deterministic && {
            declined: r.outcomes.deterministic.declined,
            total: r.outcomes.deterministic.extraction?.total ?? null,
            date: r.outcomes.deterministic.extraction?.date ?? null,
            warnings: r.outcomes.deterministic.extraction?.warnings ?? [],
          },
          model: r.outcomes.model && {
            declined: r.outcomes.model.declined,
            total: r.outcomes.model.extraction?.total ?? null,
            date: r.outcomes.model.extraction?.date ?? null,
            warnings: r.outcomes.model.extraction?.warnings ?? [],
          },
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nReport written to ${file}`);
}

main().catch((err: unknown) => {
  console.error(`Evaluation failed: ${err instanceof Error ? err.message : 'error'}`);
  process.exitCode = 1;
});
