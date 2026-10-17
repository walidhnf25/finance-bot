/**
 * Manual check of the REAL pipeline (Tesseract OCR + your Ollama), outside the unit tests:
 *
 *   npm run receipt:live-check                 renders a synthetic receipt and reads it
 *   npm run receipt:live-check -- photo.jpg    reads your own photo (nothing is stored)
 *   npm run receipt:live-check -- photo.jpg --ocr   also prints the raw OCR text
 *
 * It prints which method was used and the fields it found (the raw OCR text only with --ocr). The first run
 * downloads the Tesseract language data once into data/tessdata.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { ReceiptExtractor } from './application/receipt-extractor';
import { prepareImage, SharpImageProcessor } from './infrastructure/image-processor';
import { TesseractOcr } from './infrastructure/ocr';
import { OllamaClient } from './infrastructure/ollama.client';

const SYNTHETIC = [
  'INDOMARET CIPUTAT',
  '12/10/2026 10:15',
  'Aqua 600ml        4.000',
  'Roti Tawar        12.500',
  'TOTAL             16.500',
  'TUNAI             20.000',
  'KEMBALI            3.500',
];

async function synthetic(): Promise<Buffer> {
  const lines = SYNTHETIC.map(
    (l, i) =>
      `<text x="30" y="${60 + i * 52}" font-family="Courier New, monospace" font-size="34" fill="#111">${l.replace(/ /g, '&#160;')}</text>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="460"><rect width="720" height="460" fill="#fff"/>${lines}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showOcr = args.includes('--ocr');
  const file = args.find((a) => !a.startsWith('--'));
  const bytes = file ? readFileSync(file) : await synthetic();
  const image = await prepareImage(bytes, { maxBytes: 20 * 1_048_576, maxPixels: 50_000_000 });

  const ollama = new OllamaClient({
    provider: process.env.AI_PROVIDER === 'none' ? 'none' : 'ollama',
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL ?? '',
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000),
    maxResponseBytes: 1_048_576,
  });
  const health = await ollama.check();
  console.log(`Ollama: ${health.available ? 'available' : `unavailable (${health.detail})`}`);
  if (health.available) {
    const model = await ollama.resolveModel();
    console.log(`Model: ${model}   vision: ${(await ollama.supportsVision(model)) ? 'yes' : 'no'}`);
  }

  const tesseract = new TesseractOcr();
  // --ocr prints the raw text Tesseract read (your own photo) to help debug a misread.
  const ocr = showOcr
    ? {
        read: async (png: Buffer): Promise<string> => {
          const text = await tesseract.read(png);
          console.log(`--- OCR text ---\n${text}\n--- end ---`);
          return text;
        },
      }
    : tesseract;
  const started = Date.now();
  try {
    const { extraction, method } = await new ReceiptExtractor(
      ocr,
      ollama,
      'always',
      new SharpImageProcessor(),
    ).extract(image, {
      now: new Date(),
      timezone: process.env.TZ ?? 'Asia/Jakarta',
    });
    console.log(`Method: ${method}   (${Date.now() - started} ms)`);
    console.log(JSON.stringify(extraction, null, 2));
    if (!file) {
      const ok = extraction.total === 16500;
      console.log(
        ok
          ? 'RESULT: synthetic receipt read correctly (total 16500)'
          : 'RESULT: MISMATCH (expected total 16500)',
      );
      process.exitCode = ok ? 0 : 1;
    }
  } finally {
    await tesseract.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error(`Live check failed: ${err instanceof Error ? err.name : 'error'}`);
  process.exitCode = 1;
});
