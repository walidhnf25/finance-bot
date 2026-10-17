import { heuristicExtract } from '../domain/heuristic-extractor';
import {
  InvalidExtractionError,
  ReceiptExtraction,
  ValidationContext,
  validateExtraction,
} from '../domain/receipt-extraction';
import { OcrFailedError, PreparedImage, ReceiptOcr } from '../domain/receipt-ports';

/**
 * Deterministic extraction from OCR text: exactly what the bot falls back to when no model is
 * available, and what the evaluation harness measures. Returns null when the text states no total
 * that can be trusted (the caller then asks the user to type the amount).
 */
export function deterministicExtract(
  text: string,
  ctx: Omit<ValidationContext, 'sourceText'>,
): ReceiptExtraction | null {
  const h = heuristicExtract(text);
  if (h.total === null) return null;
  try {
    const extraction = validateExtraction(
      { merchant: h.merchant, date: h.date, total: h.total, items: [], categoryHint: null },
      { ...ctx, sourceText: text },
    );
    return { ...extraction, warnings: [...new Set([...extraction.warnings, ...h.warnings])] };
  } catch (err) {
    if (err instanceof InvalidExtractionError) return null;
    throw err;
  }
}

/** True when this text already yields a labelled, plausible total (no second OCR pass needed). */
const hasUsableTotal = (text: string): boolean => {
  const h = heuristicExtract(text);
  return h.total !== null && !h.warnings.includes('TOTAL_CONFLICTS_WITH_PAYMENT');
};

/**
 * Reads the receipt text. A second pass with stronger preprocessing (upscale, denoise, sharpen) runs
 * ONLY when the first pass produced no usable total, so clean photos stay fast. The text that yields
 * a usable total wins; when neither does, the longer one is kept for the model to try.
 */
export async function readReceiptText(
  image: PreparedImage,
  ocr: ReceiptOcr,
  enhance?: (png: Buffer) => Promise<Buffer>,
): Promise<string> {
  let first = '';
  try {
    first = (await ocr.read(image.png)).trim();
  } catch (err) {
    if (!(err instanceof OcrFailedError)) throw err;
    // A full OCR queue is not "nothing readable": the caller must tell the user to retry shortly.
    if (err.reason === 'busy') throw err;
  }
  if (first && hasUsableTotal(first)) return first;
  // Without an enhancer there is no stronger pass to try.
  if (!enhance) return first;

  let second = '';
  try {
    second = (await ocr.read(await enhance(image.png))).trim();
  } catch {
    // The second pass is an optional improvement: if it cannot run, the first result stands.
    return first;
  }
  if (second && hasUsableTotal(second)) return second;
  return second.length > first.length ? second : first;
}
