/** What the readiness check needs to know about OCR (language data present?). */
export interface OcrHealthStatus {
  available: boolean;
  detail?: string;
}

/** Implemented by the receipt module; abstract so the health module depends on no particular OCR engine. */
export abstract class OcrHealthProbe {
  abstract check(): OcrHealthStatus;
}
