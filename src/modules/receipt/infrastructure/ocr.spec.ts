import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OcrFailedError, TesseractOcr } from './ocr';

/** Recognition is replaced by a hand-released promise, so the queue can be observed without tesseract. */
class GatedOcr extends TesseractOcr {
  protected override readonly maxPending = 2;
  readonly started: number[] = [];
  private readonly gates: Array<{ release: () => void; fail: () => void }> = [];
  private counter = 0;

  protected override recognize(): Promise<string> {
    const id = (this.counter += 1);
    this.started.push(id);
    return new Promise<string>((resolve, reject) => {
      this.gates.push({
        release: () => resolve(`text-${id}`),
        fail: () => reject(new OcrFailedError('engine_error')),
      });
    });
  }
  gate(index: number) {
    return this.gates[index];
  }
}

class EmptyDirOcr extends TesseractOcr {
  protected override readonly dataDir = mkdtempSync(join(tmpdir(), 'finance-bot-tess-'));
  cleanup(): void {
    rmSync(this.dataDir, { recursive: true, force: true });
  }
  dir(): string {
    return this.dataDir;
  }
}

describe('TesseractOcr', () => {
  it('never starts (or downloads anything) when the language data is missing, and says why', async () => {
    const ocr = new EmptyDirOcr();
    try {
      await expect(ocr.read(Buffer.from('x'))).rejects.toMatchObject({
        name: 'OcrFailedError',
        reason: 'language_data_missing',
      });
      // and it keeps failing cleanly, without leaving a broken worker behind
      await expect(ocr.read(Buffer.from('x'))).rejects.toBeInstanceOf(OcrFailedError);
    } finally {
      ocr.cleanup();
    }
  });

  it('reports the language data as present only when both files exist', () => {
    const ocr = new EmptyDirOcr();
    try {
      expect(TesseractOcr.languageDataPresent(ocr.dir())).toBe(false);
      writeFileSync(join(ocr.dir(), 'eng.traineddata'), 'x');
      expect(TesseractOcr.languageDataPresent(ocr.dir())).toBe(false);
      writeFileSync(join(ocr.dir(), 'ind.traineddata'), 'x');
      expect(TesseractOcr.languageDataPresent(ocr.dir())).toBe(true);
    } finally {
      ocr.cleanup();
    }
  });

  describe('bounded queue', () => {
    const tick = () => new Promise((r) => setImmediate(r));

    it('reads one photo at a time, in order', async () => {
      const ocr = new GatedOcr();
      const a = ocr.read(Buffer.from('a'));
      const b = ocr.read(Buffer.from('b'));
      await tick();
      expect(ocr.started).toEqual([1]); // the second waits for the first
      ocr.gate(0).release();
      await expect(a).resolves.toBe('text-1');
      await tick();
      expect(ocr.started).toEqual([1, 2]);
      ocr.gate(1).release();
      await expect(b).resolves.toBe('text-2');
    });

    it('refuses a photo at once with "busy" when the queue is full, and keeps no trace of it', async () => {
      const ocr = new GatedOcr();
      const a = ocr.read(Buffer.from('a'));
      const b = ocr.read(Buffer.from('b'));
      expect(ocr.queueDepth).toBe(2);

      const started = Date.now();
      await expect(ocr.read(Buffer.from('c'))).rejects.toMatchObject({
        name: 'OcrFailedError',
        reason: 'busy',
      });
      expect(Date.now() - started).toBeLessThan(50);
      expect(ocr.queueDepth).toBe(2); // the refused photo was never counted

      await tick();
      ocr.gate(0).release();
      await a;
      await tick();
      ocr.gate(1).release();
      await b;
      expect(ocr.queueDepth).toBe(0);
    });

    it('frees a slot when a job finishes, so the next photo is accepted again', async () => {
      const ocr = new GatedOcr();
      const a = ocr.read(Buffer.from('a'));
      const b = ocr.read(Buffer.from('b'));
      await tick();
      ocr.gate(0).release();
      await a;
      const c = ocr.read(Buffer.from('c')); // accepted: only b is ahead now
      expect(ocr.queueDepth).toBe(2);
      await tick();
      ocr.gate(1).release();
      await b;
      await tick();
      ocr.gate(2).release();
      await expect(c).resolves.toBe('text-3');
    });

    it('a failed job releases its slot and does not block the ones behind it', async () => {
      const ocr = new GatedOcr();
      const a = ocr.read(Buffer.from('a'));
      const b = ocr.read(Buffer.from('b'));
      const aOutcome = a.catch((e: unknown) => e);
      await tick();
      ocr.gate(0).fail();
      expect(await aOutcome).toBeInstanceOf(OcrFailedError);
      await tick();
      ocr.gate(1).release();
      await expect(b).resolves.toBe('text-2');
      expect(ocr.queueDepth).toBe(0);
    });

    it('survives a burst far beyond the limit: only the allowed number are ever pending', async () => {
      const ocr = new GatedOcr();
      const results = Array.from({ length: 50 }, () =>
        ocr.read(Buffer.from('x')).then(
          () => 'ok',
          (e: OcrFailedError) => e.reason,
        ),
      );
      expect(ocr.queueDepth).toBe(2);
      await tick();
      ocr.gate(0).release();
      await tick();
      ocr.gate(1).release();
      const settled = await Promise.all(results);
      expect(settled.filter((r) => r === 'busy')).toHaveLength(48);
      expect(settled.filter((r) => r === 'ok')).toHaveLength(2);
    });
  });
});
