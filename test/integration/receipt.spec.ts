/**
 * REAL PostgreSQL: receipt drafts. The properties that matter for money: a photo alone never
 * creates a transaction; confirming is atomic, ownership-bound and idempotent, even when the
 * same confirmation arrives several times at once.
 */
import { PrismaService } from '../../src/database/prisma.service';
import { ReceiptExtractor } from '../../src/modules/receipt/application/receipt-extractor';
import { ReceiptService } from '../../src/modules/receipt/application/receipt.service';
import { SharpImageProcessor } from '../../src/modules/receipt/infrastructure/image-processor';
import { CategoryResolver } from '../../src/modules/category/application/category-resolver.service';
import { PrismaCategoryRepository } from '../../src/modules/category/infrastructure/prisma-category.repository';
import { validateExtraction } from '../../src/modules/receipt/domain/receipt-extraction';
import { OcrFailedError } from '../../src/modules/receipt/domain/receipt-ports';
import { PrismaReceiptRepository } from '../../src/modules/receipt/infrastructure/prisma-receipt.repository';
import { PrismaTransactionRepository } from '../../src/modules/transaction/infrastructure/prisma-transaction.repository';
import { UserEntity } from '../../src/modules/user/domain/user.entity';
import { PrismaUserRepository } from '../../src/modules/user/infrastructure/prisma-user.repository';
import { TransactionType, Wallet, WalletMode } from '../../src/shared/domain/enums';
import { Money } from '../../src/shared/utils/money';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';
import sharp from 'sharp';

const NOW = new Date('2026-10-12T05:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60 * 60_000);
const extraction = (total = 45000, over: Record<string, unknown> = {}) =>
  validateExtraction(
    {
      merchant: 'Indomaret',
      date: '2026-10-12',
      total,
      items: [],
      categoryHint: 'belanja',
      ...over,
    },
    { now: NOW, timezone: 'Asia/Jakarta', sourceText: '' },
  );

describe('receipt drafts (PostgreSQL)', () => {
  let prisma: PrismaService;
  let repo: PrismaReceiptRepository;
  let txRepo: PrismaTransactionRepository;

  beforeAll(async () => {
    prisma = await connectTestPrisma();
    repo = new PrismaReceiptRepository(prisma);
    txRepo = new PrismaTransactionRepository(prisma);
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(async () => resetDatabase(prisma));

  const build =
    (userId: string, total = 45000) =>
    () =>
      Promise.resolve({
        userId,
        type: TransactionType.EXPENSE,
        amount: Money.fromMajor(total),
        description: 'Indomaret',
        occurredAt: NOW,
        sourceMessage: 'foto struk',
        wallet: Wallet.CASH,
      });
  const txCount = (userId?: string) =>
    prisma.transaction.count({ where: userId ? { userId } : undefined });
  const draftFor = async (userId: string, sha = 'a'.repeat(64), total = 45000) => {
    const r = await repo.createDraft({
      userId,
      imageSha256: sha,
      extraction: extraction(total),
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      now: NOW,
    });
    if (r.kind !== 'created') throw new Error('expected a new draft');
    return r.draft;
  };

  describe('drafts', () => {
    it('stores a draft without creating any transaction', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      expect(d.status).toBe('PENDING');
      expect(await txCount()).toBe(0);
    });

    it('recognises the same photo: pending -> "pending_exists"', async () => {
      const u = await createUser(prisma);
      const first = await draftFor(u.id);
      const again = await repo.createDraft({
        userId: u.id,
        imageSha256: 'a'.repeat(64),
        extraction: extraction(),
        expiresAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
      });
      expect(again).toMatchObject({ kind: 'pending_exists', draft: { id: first.id } });
      expect(await prisma.receiptDraft.count()).toBe(1);
    });

    it('recognises the same photo after confirmation -> "already_confirmed", no second row', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      await repo.confirm(u.id, d.id, NOW, build(u.id));
      const again = await repo.createDraft({
        userId: u.id,
        imageSha256: 'a'.repeat(64),
        extraction: extraction(),
        expiresAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
      });
      expect(again.kind).toBe('already_confirmed');
      expect(await txCount()).toBe(1);
    });

    it('lets the same photo be used again after cancel, expiry, or deleting the transaction', async () => {
      const u = await createUser(prisma);
      const d1 = await draftFor(u.id, 'b'.repeat(64));
      await repo.cancel(u.id, d1.id);
      expect(
        (
          await repo.createDraft({
            userId: u.id,
            imageSha256: 'b'.repeat(64),
            extraction: extraction(),
            expiresAt: LATER,
            now: NOW,
          })
        ).kind,
      ).toBe('created');

      const d2 = await draftFor(u.id, 'c'.repeat(64));
      await expect(repo.confirm(u.id, d2.id, LATER, build(u.id))).resolves.toMatchObject({
        kind: 'expired',
      });
      expect(
        (
          await repo.createDraft({
            userId: u.id,
            imageSha256: 'c'.repeat(64),
            extraction: extraction(),
            expiresAt: new Date(LATER.getTime() + 1e6),
            now: LATER,
          })
        ).kind,
      ).toBe('created');

      const d3 = await draftFor(u.id, 'd'.repeat(64));
      const done = await repo.confirm(u.id, d3.id, NOW, build(u.id));
      if (done.kind !== 'confirmed') throw new Error('expected confirmed');
      await txRepo.softDelete(u.id, done.transaction.id);
      expect(
        (
          await repo.createDraft({
            userId: u.id,
            imageSha256: 'd'.repeat(64),
            extraction: extraction(),
            expiresAt: LATER,
            now: NOW,
          })
        ).kind,
      ).toBe('created');
    });

    it('two users may send an identical photo; each has their own draft', async () => {
      const a = await createUser(prisma, 'a');
      const b = await createUser(prisma, 'b');
      await draftFor(a.id, 'e'.repeat(64));
      await draftFor(b.id, 'e'.repeat(64));
      expect(await prisma.receiptDraft.count()).toBe(2);
    });

    it('race: the same photo submitted twice at once yields one draft', async () => {
      const u = await createUser(prisma);
      const make = () =>
        repo.createDraft({
          userId: u.id,
          imageSha256: 'f'.repeat(64),
          extraction: extraction(),
          expiresAt: LATER,
          now: NOW,
        });
      const results = await Promise.all([make(), make(), make(), make()]);
      expect(await prisma.receiptDraft.count()).toBe(1);
      expect(results.filter((r) => r.kind === 'created').length).toBeGreaterThanOrEqual(1);
    });

    it("updateExtraction only touches the owner's PENDING draft", async () => {
      const a = await createUser(prisma, 'a');
      const b = await createUser(prisma, 'b');
      const d = await draftFor(a.id);
      expect(await repo.updateExtraction(b.id, d.id, extraction(1), LATER)).toBe(false); // someone else's
      expect(await repo.updateExtraction(a.id, d.id, extraction(52000), LATER)).toBe(true);
      await repo.cancel(a.id, d.id);
      expect(await repo.updateExtraction(a.id, d.id, extraction(99), LATER)).toBe(false); // no longer pending
      const row = await prisma.receiptDraft.findUniqueOrThrow({ where: { id: d.id } });
      expect((row.extraction as { total: number }).total).toBe(52000);
    });

    it('cancel is ownership-bound', async () => {
      const a = await createUser(prisma, 'a');
      const b = await createUser(prisma, 'b');
      const d = await draftFor(a.id);
      expect(await repo.cancel(b.id, d.id)).toBe(false);
      expect((await prisma.receiptDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
        'PENDING',
      );
    });

    it('findPending ignores expired drafts (marking them EXPIRED is left to the retention job)', async () => {
      const u = await createUser(prisma);
      await draftFor(u.id);
      expect(await repo.findPending(u.id, NOW)).not.toBeNull();
      expect(await repo.findPending(u.id, LATER)).toBeNull();
    });

    it("countSince counts only this user's recent drafts", async () => {
      const a = await createUser(prisma, 'a');
      const b = await createUser(prisma, 'b');
      await draftFor(a.id, '1'.repeat(64));
      await draftFor(a.id, '2'.repeat(64));
      await draftFor(b.id, '3'.repeat(64));
      expect(await repo.countSince(a.id, new Date(Date.now() - 60_000))).toBe(2);
      expect(await repo.countSince(a.id, new Date(Date.now() + 60_000))).toBe(0);
    });

    describe('hasExpenseLike', () => {
      const DAY_START = new Date('2026-10-11T17:00:00.000Z'); // 2026-10-12 00:00 in Asia/Jakarta
      const DAY_END = new Date('2026-10-12T17:00:00.000Z');
      const record = (userId: string, amount: number, occurredAt: Date, key: string) =>
        txRepo.create({
          userId,
          type: TransactionType.EXPENSE,
          amount: Money.fromMajor(amount),
          description: 'x',
          occurredAt,
          sourceMessage: 'x',
          wallet: Wallet.CASH,
          messageId: key,
        });
      const like = (userId: string, amount: number) =>
        repo.hasExpenseLike(userId, Money.fromMajor(amount), DAY_START, DAY_END);

      it('finds the same amount on the same day, and nothing else', async () => {
        const u = await createUser(prisma);
        await record(u.id, 45000, NOW, 'k1');
        expect(await like(u.id, 45000)).toBe(true);
        expect(await like(u.id, 45001)).toBe(false); // another amount
        expect(
          await repo.hasExpenseLike(
            u.id,
            Money.fromMajor(45000),
            DAY_END,
            new Date(DAY_END.getTime() + 86_400_000),
          ),
        ).toBe(false); // another day
      });

      it('treats the day as half-open: the start counts, the end does not', async () => {
        const u = await createUser(prisma);
        await record(u.id, 10000, DAY_START, 'k1');
        await record(u.id, 20000, DAY_END, 'k2');
        expect(await like(u.id, 10000)).toBe(true);
        expect(await like(u.id, 20000)).toBe(false);
      });

      it("never looks at another user's expenses", async () => {
        const a = await createUser(prisma, 'a');
        const b = await createUser(prisma, 'b');
        await record(a.id, 45000, NOW, 'k1');
        expect(await like(b.id, 45000)).toBe(false);
      });

      it('ignores deleted expenses and income', async () => {
        const u = await createUser(prisma);
        const gone = await record(u.id, 30000, NOW, 'k1');
        if (!gone) throw new Error('expected a transaction');
        await prisma.transaction.update({ where: { id: gone.id }, data: { deletedAt: NOW } });
        await txRepo.create({
          userId: u.id,
          type: TransactionType.INCOME,
          amount: Money.fromMajor(50000),
          description: 'gaji',
          occurredAt: NOW,
          sourceMessage: 'x',
          wallet: Wallet.CASH,
          messageId: 'k2',
        });
        expect(await like(u.id, 30000)).toBe(false);
        expect(await like(u.id, 50000)).toBe(false);
      });
    });
  });

  describe('confirm', () => {
    it('creates exactly one transaction with the exact amount and links it to the draft', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      const r = await repo.confirm(u.id, d.id, NOW, build(u.id));
      if (r.kind !== 'confirmed') throw new Error('expected confirmed');
      expect(r.transaction.amount.equals(Money.fromMajor(45000))).toBe(true);

      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: r.transaction.id } });
      expect(row.idempotencyKey).toBe(`receipt:${d.id}`);
      expect(row.amountMinor).toBe(4_500_000n);
      const draft = await prisma.receiptDraft.findUniqueOrThrow({ where: { id: d.id } });
      expect(draft).toMatchObject({ status: 'CONFIRMED', transactionId: r.transaction.id });
    });

    it('a second confirmation never creates a second transaction', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      await repo.confirm(u.id, d.id, NOW, build(u.id));
      const second = await repo.confirm(u.id, d.id, NOW, build(u.id));
      expect(second.kind).toBe('already_confirmed');
      expect(await txCount()).toBe(1);
    });

    it('CONCURRENCY: 8 simultaneous confirmations create exactly one transaction', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repo.confirm(u.id, d.id, NOW, build(u.id))),
      );
      expect(results.filter((r) => r.kind === 'confirmed')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'already_confirmed')).toHaveLength(7);
      expect(await txCount()).toBe(1);
      const sums = await txRepo.sumByType(u.id, {
        start: new Date('2026-10-01'),
        end: new Date('2026-10-31'),
      });
      expect(sums.expense.equals(Money.fromMajor(45000))).toBe(true);
    });

    it('OWNERSHIP: another user cannot confirm (or learn about) the draft', async () => {
      const owner = await createUser(prisma, 'owner');
      const intruder = await createUser(prisma, 'intruder');
      const d = await draftFor(owner.id);
      const r = await repo.confirm(intruder.id, d.id, NOW, build(intruder.id));
      expect(r.kind).toBe('not_found');
      expect(await txCount()).toBe(0);
      expect((await prisma.receiptDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
        'PENDING',
      );
    });

    it('an unknown draft id is "not_found"', async () => {
      const u = await createUser(prisma);
      expect((await repo.confirm(u.id, 'nope', NOW, build(u.id))).kind).toBe('not_found');
    });

    it('refuses an expired draft, records nothing, and marks it EXPIRED', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      expect((await repo.confirm(u.id, d.id, LATER, build(u.id))).kind).toBe('expired');
      expect(await txCount()).toBe(0);
      expect((await prisma.receiptDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
        'EXPIRED',
      );
    });

    it('refuses a cancelled draft', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      await repo.cancel(u.id, d.id);
      expect((await repo.confirm(u.id, d.id, NOW, build(u.id))).kind).toBe('cancelled');
      expect(await txCount()).toBe(0);
    });

    it('ATOMICITY: if building the transaction fails, nothing is written and the draft stays pending', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      await expect(
        repo.confirm(u.id, d.id, NOW, () => Promise.reject(new Error('category lookup failed'))),
      ).rejects.toThrow('category lookup failed');
      expect(await txCount()).toBe(0);
      expect((await prisma.receiptDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
        'PENDING',
      );
      // and it can still be confirmed afterwards
      expect((await repo.confirm(u.id, d.id, NOW, build(u.id))).kind).toBe('confirmed');
    });

    it('ATOMICITY: a database rejection of the transaction leaves the draft pending', async () => {
      const u = await createUser(prisma);
      const d = await draftFor(u.id);
      await expect(
        repo.confirm(u.id, d.id, NOW, async () => ({
          ...(await build(u.id)()),
          amount: Money.fromMinor(0n), // violates CHECK amount_minor > 0
        })),
      ).rejects.toThrow();
      expect(await txCount()).toBe(0);
      expect((await prisma.receiptDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
        'PENDING',
      );
    });

    it('deleting the user removes their drafts (cascade)', async () => {
      const u = await createUser(prisma);
      await draftFor(u.id);
      await prisma.user.delete({ where: { id: u.id } });
      expect(await prisma.receiptDraft.count()).toBe(0);
    });
  });

  describe('ReceiptService on top of the real repositories', () => {
    const png = (width: number, shade: number) =>
      sharp({
        create: { width, height: 40, channels: 3, background: { r: shade, g: shade, b: shade } },
      })
        .png()
        .toBuffer();

    function service(maxPerHour = 20) {
      const extractor = {
        extract: jest.fn().mockResolvedValue({ extraction: extraction(), method: 'model' }),
      } as unknown as jest.Mocked<ReceiptExtractor>;
      const svc = new ReceiptService(
        repo,
        extractor,
        new CategoryResolver(new PrismaCategoryRepository(prisma)),
        { record: jest.fn().mockResolvedValue(undefined) } as never,
        new SharpImageProcessor(),
        { maxFileSizeBytes: 1_000_000, maxPixels: 4_000_000, pendingTtlMinutes: 30, maxPerHour },
      );
      return { svc, extractor };
    }
    const userEntity = async (over: Partial<UserEntity> = {}): Promise<UserEntity> => {
      const row = await createUser(prisma);
      const found = await new PrismaUserRepository(prisma).findById(row.id);
      return { ...found!, ...over };
    };

    it('photo -> draft -> confirm gives one categorised expense on the receipt date', async () => {
      const { svc } = service();
      const user = await userEntity();
      const sub = await svc.submit(user, await png(60, 255), NOW);
      expect(sub.kind).toBe('draft');
      expect(await txCount()).toBe(0);

      const done = await svc.confirm(user, NOW);
      if (done.kind !== 'confirmed') throw new Error('expected confirmed');
      expect(done.transaction.type).toBe(TransactionType.EXPENSE);
      expect(done.transaction.amount.equals(Money.fromMajor(45000))).toBe(true);
      expect(done.transaction.description).toBe('Indomaret');
      expect(done.category).not.toBeNull();
      // Noon on the receipt's date in the user's own time zone.
      expect(done.transaction.occurredAt.toISOString()).toBe('2026-10-12T05:00:00.000Z');
      expect(await svc.confirm(user, NOW)).toEqual({ kind: 'gone' }); // nothing pending any more
      expect(await txCount()).toBe(1);
    });

    it('re-sending the same photo while pending shows the same draft without reading it again', async () => {
      const { svc, extractor } = service();
      const user = await userEntity();
      const img = await png(61, 200);
      const first = await svc.submit(user, img, NOW);
      const second = await svc.submit(user, img, NOW);
      expect(first.kind).toBe('draft');
      expect(second.kind).toBe('pending_exists');
      expect(extractor.extract).toHaveBeenCalledTimes(1);
      expect(await prisma.receiptDraft.count()).toBe(1);
    });

    it('a new photo supersedes the older unanswered draft', async () => {
      const { svc } = service();
      const user = await userEntity();
      await svc.submit(user, await png(62, 10), NOW);
      await svc.submit(user, await png(63, 20), NOW);
      const rows = await prisma.receiptDraft.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.status)).toEqual(['CANCELLED', 'PENDING']);
    });

    describe('the same receipt photographed twice', () => {
      it('warns on the second photo (a different file), and the warning is only a warning', async () => {
        const { svc } = service();
        const user = await userEntity();
        const first = await svc.submit(user, await png(90, 40), NOW);
        expect(first.kind).toBe('draft');
        if (first.kind !== 'draft') return;
        expect(first.extraction.warnings).not.toContain('POSSIBLE_DUPLICATE');
        expect((await svc.confirm(user, NOW)).kind).toBe('confirmed');

        const second = await svc.submit(user, await png(91, 90), NOW); // other bytes, same receipt
        if (second.kind !== 'draft') throw new Error('expected a draft');
        expect(second.extraction.warnings).toContain('POSSIBLE_DUPLICATE');
        expect(second.extraction.total).toBe(45000);

        // the warning does not block anything: the user may still confirm it
        expect((await svc.confirm(user, NOW)).kind).toBe('confirmed');
        expect(await txCount(user.id)).toBe(2);
      });

      it('does not warn for another user with the same receipt', async () => {
        const { svc } = service();
        const a = await userEntity();
        const b = await userEntity();
        await svc.submit(a, await png(92, 40), NOW);
        await svc.confirm(a, NOW);

        const other = await svc.submit(b, await png(93, 90), NOW);
        if (other.kind !== 'draft') throw new Error('expected a draft');
        expect(other.extraction.warnings).not.toContain('POSSIBLE_DUPLICATE');
      });

      it('re-checks after the user corrects the total or the date', async () => {
        const { svc } = service();
        const user = await userEntity();
        await svc.submit(user, await png(94, 40), NOW);
        await svc.confirm(user, NOW);
        const second = await svc.submit(user, await png(95, 90), NOW);
        if (second.kind !== 'draft') throw new Error('expected a draft');
        expect(second.extraction.warnings).toContain('POSSIBLE_DUPLICATE');

        const otherTotal = await svc.correct(user, { total: 51000 }, NOW);
        expect(otherTotal?.extraction.warnings).not.toContain('POSSIBLE_DUPLICATE');

        const backAgain = await svc.correct(user, { total: 45000 }, NOW);
        expect(backAgain?.extraction.warnings).toContain('POSSIBLE_DUPLICATE');

        const otherDay = await svc.correct(user, { date: '2026-10-05' }, NOW);
        expect(otherDay?.extraction.warnings).not.toContain('POSSIBLE_DUPLICATE');
      });

      it('keeps the flag when the pending draft is shown again from the database', async () => {
        const { svc } = service();
        const user = await userEntity();
        await svc.submit(user, await png(96, 40), NOW);
        await svc.confirm(user, NOW);
        await svc.submit(user, await png(97, 90), NOW);
        const shown = await svc.pending(user, NOW);
        expect(shown?.extraction.warnings).toContain('POSSIBLE_DUPLICATE');
      });
    });

    it('limits drafts per hour', async () => {
      const { svc } = service(2);
      const user = await userEntity();
      await svc.submit(user, await png(70, 1), new Date());
      await svc.submit(user, await png(71, 2), new Date());
      expect((await svc.submit(user, await png(72, 3), new Date())).kind).toBe('rate_limited');
    });

    it('a full OCR queue answers "busy": nothing is stored and it does not use up the hourly allowance', async () => {
      const { svc, extractor } = service(1);
      const user = await userEntity();
      extractor.extract.mockRejectedValueOnce(new OcrFailedError('busy'));

      expect(await svc.submit(user, await png(80, 1), NOW)).toEqual({ kind: 'busy' });
      expect(await prisma.receiptDraft.count()).toBe(0);

      // the allowance is intact: the retry (OCR free again) is accepted, not rate limited
      const retry = await svc.submit(user, await png(80, 1), NOW);
      expect(retry.kind).toBe('draft');
      expect(await prisma.receiptDraft.count()).toBe(1);
    });

    it('rejects non-images and does not store anything', async () => {
      const { svc, extractor } = service();
      const user = await userEntity();
      const r = await svc.submit(user, Buffer.from('MZ\x90\x00 definitely an exe'), NOW);
      expect(r).toEqual({ kind: 'rejected_image', reason: 'unsupported' });
      expect(extractor.extract).not.toHaveBeenCalled();
      expect(await prisma.receiptDraft.count()).toBe(0);
    });

    it('corrections change the draft but never create a transaction', async () => {
      const { svc } = service();
      const user = await userEntity();
      await svc.submit(user, await png(80, 99), NOW);
      const corrected = await svc.correct(user, { total: 52000, wallet: Wallet.DIGITAL }, NOW);
      expect(corrected?.extraction.total).toBe(52000);
      expect(await txCount()).toBe(0);

      const done = await svc.confirm(user, NOW);
      if (done.kind !== 'confirmed') throw new Error('expected confirmed');
      expect(done.transaction.amount.equals(Money.fromMajor(52000))).toBe(true);
      expect(done.transaction.wallet).toBe(Wallet.DIGITAL);
    });

    it('a correction near the deadline returns the EXTENDED expiry, so the conversation keeps it', async () => {
      const { svc } = service();
      const user = await userEntity();
      const submitted = await svc.submit(user, await png(81, 97), NOW);
      if (submitted.kind !== 'draft') throw new Error('expected a draft');
      const later = new Date(submitted.draft.expiresAt.getTime() - 60_000); // one minute before it lapses
      const corrected = await svc.correct(user, { total: 51000 }, later);
      expect(corrected).not.toBeNull();
      expect(corrected!.draft.expiresAt.getTime()).toBeGreaterThan(
        submitted.draft.expiresAt.getTime(),
      );
      const stored = await prisma.receiptDraft.findFirstOrThrow({ where: { userId: user.id } });
      expect(corrected!.draft.expiresAt.getTime()).toBe(stored.expiresAt.getTime());
    });

    it('REGRESSION: a user who never set up wallets stays wallet-less after a receipt', async () => {
      const { svc } = service();
      const user = await userEntity({ walletMode: null, defaultWallet: null });
      await svc.submit(user, await png(83, 96), NOW);
      expect(svc.walletFor(user, extraction())).toBeNull();
      const done = await svc.confirm(user, NOW);
      if (done.kind !== 'confirmed') throw new Error('expected confirmed');
      // Stamping a wallet here would flip the user into "both wallets" and every later entry
      // would start asking "cash or digital?".
      expect(done.transaction.wallet).toBeNull();
    });

    it('a both-wallets user without a default sees CASH in the preview and can change it', async () => {
      const { svc } = service();
      const user = await userEntity({ walletMode: WalletMode.BOTH, defaultWallet: null });
      expect(svc.walletFor(user, extraction())).toBe(Wallet.CASH);
      expect(svc.walletFor(user, extraction(45000, { wallet: Wallet.DIGITAL }))).toBe(
        Wallet.DIGITAL,
      );
      const withDefault = await userEntity({
        walletMode: WalletMode.BOTH,
        defaultWallet: Wallet.DIGITAL,
      });
      expect(svc.walletFor(withDefault, extraction())).toBe(Wallet.DIGITAL);
    });

    it('a one-wallet user always gets that wallet, whatever the draft says', async () => {
      const { svc } = service();
      const user = await userEntity({ walletMode: WalletMode.CASH });
      await svc.submit(user, await png(81, 98), NOW);
      await svc.correct(user, { wallet: Wallet.DIGITAL }, NOW);
      const done = await svc.confirm(user, NOW);
      if (done.kind !== 'confirmed') throw new Error('expected confirmed');
      expect(done.transaction.wallet).toBe(Wallet.CASH);
    });

    it("one user's draft cannot be confirmed through another user's session", async () => {
      const { svc } = service();
      const owner = await userEntity();
      const other = await userEntity();
      await svc.submit(owner, await png(82, 97), NOW);
      expect(await svc.confirm(other, NOW)).toEqual({ kind: 'gone' });
      expect(await svc.correct(other, { total: 1 }, NOW)).toBeNull();
      expect(await txCount()).toBe(0);
    });
  });
});
