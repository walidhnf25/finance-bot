// One-time download of the Tesseract language data used for receipt OCR (Indonesian + English).
// Source: the official tesseract-ocr/tessdata_fast repository. Run: npm run receipt:fetch-langdata
// Files are written to data/tessdata (git-ignored). After this, OCR needs no network access.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main';
const FILES = ['ind.traineddata', 'eng.traineddata'];
const MAX_BYTES = 20 * 1024 * 1024;
const dir = join(process.cwd(), 'data', 'tessdata');
mkdirSync(dir, { recursive: true });

for (const name of FILES) {
  const target = join(dir, name);
  if (existsSync(target) && !process.argv.includes('--force')) {
    console.log(`${name}: already present (use --force to download again)`);
    continue;
  }
  const res = await fetch(`${BASE}/${name}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 100_000 || bytes.length > MAX_BYTES) {
    throw new Error(`${name}: unexpected size ${bytes.length} bytes`);
  }
  const tmp = `${target}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(`${name}: ${bytes.length} bytes, sha256 ${sha}`);
}
console.log(`Language data is in ${dir}`);
