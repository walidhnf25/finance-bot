import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { OcrFailedError, ReceiptOcr } from '../domain/receipt-ports';

// Re-exported so existing imports keep working; the definitions live in the domain ports.
export { OcrFailedError, ReceiptOcr };

/** Longest OCR text handed on: bounds the prompt size and what could be injected through the photo. */
export const MAX_OCR_CHARS = 6_000;
const OCR_TIMEOUT_MS = 60_000;
/**
 * Photos allowed to wait for the single OCR worker (the one being read included). Each waiting job holds
 * its image in memory, so an unbounded queue turns a burst of photos into unbounded memory. Past this
 * depth a photo is refused at once with `busy` and the user is asked to retry shortly.
 */
export const MAX_OCR_PENDING = 6;
/** Languages read from every receipt; the files live in {@link TESSDATA_DIR}. */
export const OCR_LANGUAGES = ['ind', 'eng'] as const;
export const TESSDATA_DIR = join(process.cwd(), 'data', 'tessdata');

/**
 * OCR with tesseract.js (Indonesian + English). Language data is read from `data/tessdata`
 * (git-ignored) and is NEVER fetched implicitly at runtime: install it once with
 * `npm run receipt:fetch-langdata`. Without it OCR reports "language_data_missing" and the bot
 * falls back to asking the user to type the amount. One worker is created lazily and reused;
 * recognition runs one image at a time.
 */
@Injectable()
export class TesseractOcr extends ReceiptOcr implements OnModuleDestroy {
  private readonly logger = new Logger(TesseractOcr.name);
  private worker: Promise<import('tesseract.js').Worker> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Overridable in tests. */
  protected readonly dataDir: string = TESSDATA_DIR;
  protected readonly maxPending: number = MAX_OCR_PENDING;
  /** Jobs running or waiting. */
  private pending = 0;

  constructor(@Optional() private readonly metrics?: MetricsService) {
    super();
    metrics?.registerGauge('ocr_queue_depth', () => this.pending);
  }

  /** True when the language files are present (health/diagnostics can use this). */
  static languageDataPresent(dir: string = TESSDATA_DIR): boolean {
    return OCR_LANGUAGES.every((l) => existsSync(join(dir, `${l}.traineddata`)));
  }

  private getWorker(): Promise<import('tesseract.js').Worker> {
    this.worker ??= (async () => {
      if (!TesseractOcr.languageDataPresent(this.dataDir))
        throw new OcrFailedError('language_data_missing');
      const { createWorker } = await import('tesseract.js');
      return createWorker([...OCR_LANGUAGES], 1, {
        langPath: this.dataDir,
        cacheMethod: 'none',
        gzip: false,
        // Without a handler tesseract.js rethrows worker errors on the event loop and kills the process.
        errorHandler: () => {
          this.logger.warn('OCR worker reported an error; it will be recreated');
          this.worker = null;
        },
      });
    })().catch((err: unknown) => {
      this.worker = null; // allow a later retry (for instance once the data is installed)
      throw err;
    });
    return this.worker;
  }

  /** Number of photos currently running or waiting (exposed for metrics and tests). */
  get queueDepth(): number {
    return this.pending;
  }

  read(png: Buffer): Promise<string> {
    // Bounded: refuse at once instead of queueing without limit.
    if (this.pending >= this.maxPending) {
      this.metrics?.inc('ocr_failures_total', { reason: 'busy' });
      return Promise.reject(new OcrFailedError('busy'));
    }
    this.pending += 1;
    const run = (): Promise<string> => this.recognize(png);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next.finally(() => {
      this.pending -= 1;
    });
  }

  /** One recognition on the shared worker, with its own timeout. Overridable in tests. */
  protected async recognize(png: Buffer): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const worker = await this.getWorker();
      const result = await Promise.race([
        worker.recognize(png),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new OcrFailedError('timeout')), OCR_TIMEOUT_MS);
        }),
      ]);
      return result.data.text.slice(0, MAX_OCR_CHARS);
    } catch (err) {
      const failure = err instanceof OcrFailedError ? err : new OcrFailedError('engine_error');
      this.metrics?.inc('ocr_failures_total', { reason: failure.reason });
      if (failure.reason !== 'language_data_missing') {
        // A timed-out or failed worker may be wedged: drop it so the next request starts clean.
        const stale = this.worker;
        this.worker = null;
        void stale?.then((w) => w.terminate()).catch(() => undefined);
      }
      this.logger.warn(
        failure.reason === 'language_data_missing'
          ? 'OCR language data is missing: run "npm run receipt:fetch-langdata"'
          : `OCR failed (${failure.reason})`,
      );
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const w = await this.worker?.catch(() => null);
    await w?.terminate().catch(() => undefined);
  }
}
