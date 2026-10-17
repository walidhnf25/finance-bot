/**
 * Ports of the receipt pipeline. The application layer (extractor, reader, service) depends on THESE
 * abstractions, never on sharp, tesseract.js or an Ollama HTTP client, so each of those can be replaced
 * (a vision model, another OCR service, a fake in a test) without touching the financial rules.
 * The implementations live in `../infrastructure`.
 */

// ---- images -------------------------------------------------------------------------------------

export class InvalidImageError extends Error {
  constructor(
    readonly reason: 'too_large' | 'not_an_image' | 'unsupported' | 'too_many_pixels' | 'corrupt',
  ) {
    super(`Image rejected: ${reason}`);
    this.name = 'InvalidImageError';
  }
}

export interface PreparedImage {
  /** Normalised, metadata-free image used for OCR / vision (PNG, upright, bounded size). */
  png: Buffer;
  /** Hash of the ORIGINAL bytes: the duplicate-detection key. */
  sha256: string;
  width: number;
  height: number;
}

export interface ImageLimits {
  maxBytes: number;
  maxPixels: number;
}

/** Validates and normalises an untrusted image, and offers the stronger second-pass preprocessing for OCR. */
export abstract class ReceiptImageProcessor {
  /** Throws {@link InvalidImageError}; never returns an image that exceeded the limits. */
  abstract prepare(bytes: Buffer, limits: ImageLimits): Promise<PreparedImage>;
  abstract enhanceForOcr(png: Buffer): Promise<Buffer>;
}

// ---- OCR ----------------------------------------------------------------------------------------

export class OcrFailedError extends Error {
  constructor(
    readonly reason:
      | 'language_data_missing'
      | 'engine_error'
      | 'timeout'
      /** The bounded OCR queue is full: the caller should ask the user to try again shortly. */
      | 'busy' = 'engine_error',
  ) {
    super(`OCR failed (${reason})`);
    this.name = 'OcrFailedError';
  }
}

/** Reads text from a prepared receipt image. */
export abstract class ReceiptOcr {
  abstract read(png: Buffer): Promise<string>;
}

// ---- AI interpretation (optional) -----------------------------------------------------------------

export class AiUnavailableError extends Error {
  constructor(
    readonly reason: 'disabled' | 'unreachable' | 'no_model' | 'bad_response' | 'unsupported',
  ) {
    super(`AI unavailable: ${reason}`);
    this.name = 'AiUnavailableError';
  }
}

export interface ChatJsonRequest {
  model: string;
  system: string;
  user: string;
  schema: object;
  imagesBase64?: string[];
}

/**
 * A model that can propose structured values for a receipt. Its reply is UNTRUSTED text: the caller
 * parses and validates it, and it never commits anything by itself.
 */
export abstract class ReceiptAiProvider {
  abstract get enabled(): boolean;
  /** The model to use; throws {@link AiUnavailableError} when none is usable. Never assumes a model exists. */
  abstract resolveModel(): Promise<string>;
  /** True only when the model itself reports the capability. */
  abstract supportsVision(model: string): Promise<boolean>;
  abstract chatJson(request: ChatJsonRequest): Promise<string>;
}
