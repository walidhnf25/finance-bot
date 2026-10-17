import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { CategoryModule } from '../category/category.module';
import { AiHealthProbe } from '../health/ai-health.probe';
import { OcrHealthProbe } from '../health/ocr-health.probe';
import { AiMode, RECEIPT_AI_MODE, ReceiptExtractor } from './application/receipt-extractor';
import { RECEIPT_LIMITS, ReceiptLimits, ReceiptService } from './application/receipt.service';
import { ReceiptRepository } from './domain/receipt.repository';
import { ReceiptAiProvider, ReceiptImageProcessor, ReceiptOcr } from './domain/receipt-ports';
import { SharpImageProcessor } from './infrastructure/image-processor';
import { TesseractOcr } from './infrastructure/ocr';
import { TesseractOcrHealthProbe } from './infrastructure/ocr-health';
import { OLLAMA_SETTINGS, OllamaClient } from './infrastructure/ollama.client';
import { PrismaReceiptRepository } from './infrastructure/prisma-receipt.repository';

/** Receipt photos: OCR + Ollama, human confirmation, atomic idempotent confirmation. */
@Module({
  imports: [AuditModule, CategoryModule],
  providers: [
    { provide: ReceiptRepository, useClass: PrismaReceiptRepository },
    { provide: ReceiptOcr, useClass: TesseractOcr },
    { provide: ReceiptImageProcessor, useClass: SharpImageProcessor },
    {
      provide: OLLAMA_SETTINGS,
      useFactory: (config: ConfigService) => OllamaClient.fromConfig(config),
      inject: [ConfigService],
    },
    {
      provide: RECEIPT_LIMITS,
      useFactory: (config: ConfigService) => config.getOrThrow<ReceiptLimits>('receipt'),
      inject: [ConfigService],
    },
    {
      provide: RECEIPT_AI_MODE,
      useFactory: (config: ConfigService) =>
        config.getOrThrow<{ aiMode: AiMode }>('receipt').aiMode,
      inject: [ConfigService],
    },
    OllamaClient,
    { provide: AiHealthProbe, useExisting: OllamaClient },
    { provide: ReceiptAiProvider, useExisting: OllamaClient },
    { provide: OcrHealthProbe, useClass: TesseractOcrHealthProbe },
    ReceiptExtractor,
    ReceiptService,
  ],
  exports: [ReceiptService, AiHealthProbe, OcrHealthProbe, ReceiptRepository],
})
export class ReceiptModule {}
