import { Inject, Injectable, Optional } from '@nestjs/common';
import dayjs from 'dayjs';
import timezonePlugin from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { AuditLogRepository } from 'src/modules/audit/domain/audit-log.repository';
import { CategoryResolver } from 'src/modules/category/application/category-resolver.service';
import { CategoryEntity } from 'src/modules/category/domain/category.entity';
import { TransactionEntity } from 'src/modules/transaction/domain/transaction.entity';
import { UserEntity } from 'src/modules/user/domain/user.entity';
import { TransactionType, Wallet, WalletMode } from 'src/shared/domain/enums';
import { Money } from 'src/shared/utils/money';
import { tokenize } from 'src/shared/utils/string-normalizer';
import { ReceiptCorrection } from '../domain/receipt-correction';
import {
  InvalidExtractionError,
  ReceiptExtraction,
  reviveExtraction,
  validateExtraction,
} from '../domain/receipt-extraction';
import { ReceiptDraftEntity, ReceiptRepository } from '../domain/receipt.repository';
import { MetricsService } from 'src/modules/observability/metrics.service';
import { InvalidImageError, OcrFailedError, ReceiptImageProcessor } from '../domain/receipt-ports';
import { ExtractionMethod, NothingReadableError, ReceiptExtractor } from './receipt-extractor';

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

export interface ReceiptLimits {
  maxFileSizeBytes: number;
  maxPixels: number;
  pendingTtlMinutes: number;
  maxPerHour: number;
}
export const RECEIPT_LIMITS = Symbol('RECEIPT_LIMITS');

export type SubmitResult =
  | {
      kind: 'draft';
      draft: ReceiptDraftEntity;
      extraction: ReceiptExtraction;
      method: ExtractionMethod;
    }
  | { kind: 'pending_exists'; draft: ReceiptDraftEntity; extraction: ReceiptExtraction }
  | { kind: 'already_confirmed' }
  | { kind: 'rate_limited' }
  | { kind: 'rejected_image'; reason: InvalidImageError['reason'] }
  | { kind: 'unreadable' }
  /** The OCR queue is full: nothing was stored, the user may retry in a moment. */
  | { kind: 'busy' };

export type ConfirmOutcome =
  | { kind: 'confirmed'; transaction: TransactionEntity; category: CategoryEntity | null }
  | { kind: 'already_confirmed' }
  | { kind: 'expired' }
  | { kind: 'gone' };

const HOUR_MS = 3_600_000;

/**
 * The receipt-photo flow. A photo only ever produces a DRAFT; a transaction exists only after the
 * user confirms it, and confirmation is a single locked, idempotent database transaction.
 */
@Injectable()
export class ReceiptService {
  constructor(
    private readonly drafts: ReceiptRepository,
    private readonly extractor: ReceiptExtractor,
    private readonly categories: CategoryResolver,
    private readonly audit: AuditLogRepository,
    private readonly images: ReceiptImageProcessor,
    @Inject(RECEIPT_LIMITS) private readonly limits: ReceiptLimits,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** The announced size can be checked before anything is downloaded. */
  exceedsSize(announcedBytes: number | undefined): boolean {
    return announcedBytes !== undefined && announcedBytes > this.limits.maxFileSizeBytes;
  }

  get maxFileSizeBytes(): number {
    return this.limits.maxFileSizeBytes;
  }

  private expiry(now: Date): Date {
    return new Date(now.getTime() + this.limits.pendingTtlMinutes * 60_000);
  }

  /** Counts the outcome and times the whole submission; the work itself is in {@link submitCore}. */
  async submit(user: UserEntity, bytes: Buffer, now: Date): Promise<SubmitResult> {
    const started = performance.now();
    try {
      const result = await this.submitCore(user, bytes, now);
      this.metrics?.inc('receipts_total', { outcome: result.kind });
      return result;
    } catch (err) {
      this.metrics?.inc('receipts_total', { outcome: 'error' });
      throw err;
    } finally {
      this.metrics?.observe('receipt_duration_ms', performance.now() - started);
    }
  }

  private async submitCore(user: UserEntity, bytes: Buffer, now: Date): Promise<SubmitResult> {
    if (
      (await this.drafts.countSince(user.id, new Date(now.getTime() - HOUR_MS))) >=
      this.limits.maxPerHour
    ) {
      return { kind: 'rate_limited' };
    }

    let image;
    try {
      image = await this.images.prepare(bytes, {
        maxBytes: this.limits.maxFileSizeBytes,
        maxPixels: this.limits.maxPixels,
      });
    } catch (err) {
      if (err instanceof InvalidImageError) return { kind: 'rejected_image', reason: err.reason };
      throw err;
    }

    // The same photo is still waiting: show that draft, no need to read it all over again.
    const waiting = await this.drafts.findPendingByImage(user.id, image.sha256, now);
    if (waiting) {
      return {
        kind: 'pending_exists',
        draft: waiting,
        extraction: reviveExtraction(waiting.extraction, now, user.timezone),
      };
    }

    let outcome;
    try {
      outcome = await this.extractor.extract(image, { now, timezone: user.timezone });
    } catch (err) {
      if (err instanceof NothingReadableError) return { kind: 'unreadable' };
      if (err instanceof OcrFailedError && err.reason === 'busy') return { kind: 'busy' };
      throw err;
    }

    // A fresh photo replaces any older draft the user never answered.
    const previous = await this.drafts.findPending(user.id, now);
    const created = await this.drafts.createDraft({
      userId: user.id,
      imageSha256: image.sha256,
      extraction: outcome.extraction,
      expiresAt: this.expiry(now),
      now,
    });

    if (created.kind === 'already_confirmed') return created;
    if (created.kind === 'pending_exists') {
      return {
        kind: 'pending_exists',
        draft: created.draft,
        extraction: reviveExtraction(created.draft.extraction, now, user.timezone),
      };
    }
    if (previous && previous.id !== created.draft.id)
      await this.drafts.cancel(user.id, previous.id);

    // Counts and the method only: never the amount, merchant or text.
    await this.audit.record({
      userId: user.id,
      action: 'RECEIPT_DRAFT',
      metadata: { method: outcome.method, warnings: outcome.extraction.warnings.length },
    });
    return {
      kind: 'draft',
      draft: created.draft,
      extraction: outcome.extraction,
      method: outcome.method,
    };
  }

  async pending(
    user: UserEntity,
    now: Date,
  ): Promise<{ draft: ReceiptDraftEntity; extraction: ReceiptExtraction } | null> {
    const draft = await this.drafts.findPending(user.id, now);
    if (!draft) return null;
    return { draft, extraction: reviveExtraction(draft.extraction, now, user.timezone) };
  }

  /** Apply the user's corrections and return the updated draft; null when nothing is pending. */
  async correct(
    user: UserEntity,
    correction: ReceiptCorrection,
    now: Date,
  ): Promise<{ draft: ReceiptDraftEntity; extraction: ReceiptExtraction } | null> {
    const current = await this.pending(user, now);
    if (!current) return null;
    const { draft, extraction } = current;

    const warnings = extraction.warnings.filter(
      (w) =>
        !(w === 'TOTAL_NOT_IN_TEXT' && correction.total !== undefined) &&
        !(w === 'ITEMS_DO_NOT_ADD_UP' && correction.total !== undefined) &&
        !(w === 'TOTAL_DERIVED' && correction.total !== undefined) &&
        !(w === 'TOTAL_CONFLICTS_WITH_PAYMENT' && correction.total !== undefined) &&
        !(w === 'TOTAL_DISPUTED' && correction.total !== undefined) &&
        !(w === 'TOTAL_UNLABELLED' && correction.total !== undefined) &&
        !(w === 'DATE_MISSING' && correction.date !== undefined) &&
        !(w === 'DATE_ADJUSTED' && correction.date !== undefined) &&
        !(w === 'DATE_OLD' && correction.date !== undefined) &&
        !(w === 'MERCHANT_MISSING' && correction.merchant !== undefined),
    );
    let next: ReceiptExtraction;
    try {
      next = validateExtraction(
        {
          ...extraction,
          total: correction.total ?? extraction.total,
          date: correction.date ?? extraction.date,
          merchant: correction.merchant ?? extraction.merchant,
          categoryHint: correction.categoryHint ?? extraction.categoryHint,
          wallet: correction.wallet ?? extraction.wallet,
        },
        { now, timezone: user.timezone, sourceText: '' },
      );
    } catch (err) {
      if (err instanceof InvalidExtractionError) return null;
      throw err;
    }
    // An explicit user value replaces the machine warnings it addresses; the rest stay.
    next = { ...next, warnings: [...new Set([...next.warnings, ...warnings])] };

    const expiresAt = this.expiry(now);
    const ok = await this.drafts.updateExtraction(user.id, draft.id, next, expiresAt);
    // The returned draft carries the NEW expiry, so the conversation does not keep the old (shorter) one.
    return ok ? { draft: { ...draft, extraction: next, expiresAt }, extraction: next } : null;
  }

  async cancel(user: UserEntity, now: Date): Promise<boolean> {
    const current = await this.drafts.findPending(user.id, now);
    if (!current) return false;
    const cancelled = await this.drafts.cancel(user.id, current.id);
    if (cancelled) {
      await this.audit.record({
        userId: user.id,
        action: 'RECEIPT_CANCEL',
        metadata: { draftId: current.id },
      });
    }
    return cancelled;
  }

  async confirm(user: UserEntity, now: Date): Promise<ConfirmOutcome> {
    const current = await this.drafts.findPending(user.id, now);
    if (!current) return { kind: 'gone' };

    const resolved: { category: CategoryEntity | null } = { category: null };
    const result = await this.drafts.confirm(user.id, current.id, now, async (stored) => {
      const extraction = reviveExtraction(stored, now, user.timezone);
      resolved.category = await this.categories.resolve(
        this.keywordsFor(extraction),
        TransactionType.EXPENSE,
        user.id,
      );
      return {
        userId: user.id,
        categoryId: resolved.category?.id ?? null,
        type: TransactionType.EXPENSE,
        amount: Money.fromMajor(extraction.total),
        description: extraction.merchant ?? 'Struk belanja',
        occurredAt: this.occurredAt(extraction, now, user.timezone),
        // The photo's text is deliberately not stored; the marker is enough to trace the origin.
        sourceMessage: 'foto struk',
        wallet: this.walletFor(user, extraction),
      };
    });

    switch (result.kind) {
      case 'confirmed':
        await this.audit.record({
          userId: user.id,
          action: 'RECEIPT_CONFIRM',
          metadata: { transactionId: result.transaction.id },
        });
        return { kind: 'confirmed', transaction: result.transaction, category: resolved.category };
      case 'already_confirmed':
        return { kind: 'already_confirmed' };
      case 'expired':
        return { kind: 'expired' };
      default:
        return { kind: 'gone' };
    }
  }

  /**
   * Wallet shown in the preview and used on confirmation. Same rules as a typed transaction:
   * a one-wallet user always gets that wallet; otherwise the wallet the user named, then their
   * default. A user who never set up wallets (mode null) stays wallet-less: stamping CASH on the
   * receipt would silently switch them into "both wallets" and every later entry would start
   * asking "cash or digital?". Users of both wallets without a default see CASH in the preview and
   * can change it ("dompet digital") before confirming.
   */
  walletFor(user: UserEntity, extraction: ReceiptExtraction): Wallet | null {
    if (user.walletMode === WalletMode.CASH) return Wallet.CASH;
    if (user.walletMode === WalletMode.DIGITAL) return Wallet.DIGITAL;
    const chosen = extraction.wallet ?? user.defaultWallet;
    if (chosen) return chosen;
    return user.walletMode === WalletMode.BOTH ? Wallet.CASH : null;
  }

  private occurredAt(extraction: ReceiptExtraction, now: Date, timezone: string): Date {
    if (!extraction.date) return now;
    return dayjs.tz(`${extraction.date} 12:00`, timezone).toDate();
  }

  private keywordsFor(extraction: ReceiptExtraction): string[] {
    const words = [
      ...(extraction.categoryHint ? tokenize(extraction.categoryHint) : []),
      ...tokenize(extraction.merchant ?? ''),
      ...extraction.items.flatMap((i) => tokenize(i.name)),
    ];
    return [...new Set(words)].slice(0, 20);
  }
}
