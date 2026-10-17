import { Injectable } from '@nestjs/common';
import { OcrHealthProbe, OcrHealthStatus } from 'src/modules/health/ocr-health.probe';
import { TesseractOcr } from './ocr';

/** Readiness view of the OCR capability: are the language files installed? Fixed strings only. */
@Injectable()
export class TesseractOcrHealthProbe extends OcrHealthProbe {
  check(): OcrHealthStatus {
    return TesseractOcr.languageDataPresent()
      ? { available: true }
      : {
          available: false,
          detail: 'OCR language data is missing (npm run receipt:fetch-langdata)',
        };
  }
}
