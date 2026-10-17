/**
 * Database-level tenant guards (migration 20261017000000_init). The application already names the
 * owner in every query; these tests attack the DATABASE directly, as a buggy future query or a hand-run
 * statement would, and expect it to refuse a row that points at another user's category or transaction.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../../src/database/prisma.service';
import { connectTestPrisma, createUser, resetDatabase } from '../setup/test-db';

describe('tenant guards (PostgreSQL triggers)', () => {
  let prisma: PrismaService;
  let alice: string;
  let bob: string;
  let aliceCategory: string;
  let bobCategory: string;
  let systemCategory: string;
  let aliceTx: string;
  let bobTx: string;

  const tx = (userId: string, categoryId: string | null, key: string) =>
    prisma.transaction.create({
      data: {
        userId,
        type: 'EXPENSE',
        amountMinor: 1_000n,
        categoryId,
        description: 'probe',
        occurredAt: new Date('2026-07-15T05:00:00Z'),
        idempotencyKey: key,
      },
    });
  const rejected = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
    } catch (err) {
      return String((err as Error).message);
    }
    return 'ACCEPTED';
  };

  beforeAll(async () => {
    prisma = await connectTestPrisma();
  });
  afterAll(async () => prisma.$disconnect());

  beforeEach(async () => {
    await resetDatabase(prisma);
    alice = (await createUser(prisma, 'alice')).id;
    bob = (await createUser(prisma, 'bob')).id;
    aliceCategory = (
      await prisma.category.create({
        data: { id: 'cat-alice', userId: alice, name: 'Alice makan', type: 'EXPENSE' },
      })
    ).id;
    bobCategory = (
      await prisma.category.create({
        data: { id: 'cat-bob', userId: bob, name: 'Bob makan', type: 'EXPENSE' },
      })
    ).id;
    systemCategory = (
      await prisma.category.create({
        data: {
          id: 'system-expense-x',
          userId: null,
          name: 'Sistem',
          type: 'EXPENSE',
          isSystem: true,
        },
      })
    ).id;
    aliceTx = (await tx(alice, aliceCategory, 'a-1')).id;
    bobTx = (await tx(bob, bobCategory, 'b-1')).id;
  });

  describe("a row may only use its owner's category, or a shared system category", () => {
    it("accepts the owner's own category, a system category, and no category", async () => {
      await expect(tx(alice, aliceCategory, 'ok-1')).resolves.toBeDefined();
      await expect(tx(alice, systemCategory, 'ok-2')).resolves.toBeDefined();
      await expect(tx(alice, null, 'ok-3')).resolves.toBeDefined();
    });

    it("refuses a transaction that names another user's category", async () => {
      const message = await rejected(tx(alice, bobCategory, 'x-1'));
      expect(message).toContain('category does not belong');
      expect(await prisma.transaction.count({ where: { userId: alice } })).toBe(1); // only the seed row
    });

    it("refuses to MOVE an existing transaction onto another user's category", async () => {
      const message = await rejected(
        prisma.transaction.update({ where: { id: aliceTx }, data: { categoryId: bobCategory } }),
      );
      expect(message).toContain('category does not belong');
      expect(
        (await prisma.transaction.findUniqueOrThrow({ where: { id: aliceTx } })).categoryId,
      ).toBe(aliceCategory);
    });

    it('refuses to reassign a transaction to another OWNER while it keeps its category', async () => {
      const message = await rejected(
        prisma.$executeRaw`UPDATE transactions SET user_id = ${bob} WHERE id = ${aliceTx}`,
      );
      expect(message).toContain('category does not belong');
    });

    it('guards budgets the same way', async () => {
      const budget = (userId: string, categoryId: string, scope: string) =>
        prisma.budget.create({
          data: {
            userId,
            categoryId,
            scopeKey: scope,
            period: 'MONTHLY',
            amountMinor: 500_000n,
            alertThreshold: 80,
          },
        });
      await expect(budget(alice, aliceCategory, aliceCategory)).resolves.toBeDefined();
      expect(await rejected(budget(alice, bobCategory, bobCategory))).toContain(
        'category does not belong',
      );
    });

    it('is enforced even for raw SQL that bypasses the ORM', async () => {
      const message = await rejected(
        prisma.$executeRaw`INSERT INTO transactions (id, user_id, type, amount_minor, category_id, description, occurred_at, created_at, updated_at)
          VALUES (gen_random_uuid(), ${alice}, 'EXPENSE', 100, ${bobCategory}, 'raw', now(), now(), now())`,
      );
      expect(message).toContain('category does not belong');
    });
  });

  describe('a category that is in use cannot be handed to another owner', () => {
    it('refuses the move while the owner still has transactions or budgets on it', async () => {
      const message = await rejected(
        prisma.category.update({ where: { id: aliceCategory }, data: { userId: bob } }),
      );
      expect(message).toContain('still used');
      expect(
        (await prisma.category.findUniqueOrThrow({ where: { id: aliceCategory } })).userId,
      ).toBe(alice);
    });

    it('allows the move of a category nothing uses', async () => {
      const spare = await prisma.category.create({
        data: { id: 'cat-spare', userId: alice, name: 'Spare', type: 'EXPENSE' },
      });
      await expect(
        prisma.category.update({ where: { id: spare.id }, data: { userId: bob } }),
      ).resolves.toBeDefined();
    });
  });

  describe("a receipt draft may only be linked to its owner's transaction", () => {
    const draft = (userId: string, transactionId: string | null, sha: string) =>
      prisma.receiptDraft.create({
        data: {
          userId,
          status: transactionId ? 'CONFIRMED' : 'PENDING',
          extraction: {},
          imageSha256: sha.repeat(64).slice(0, 64),
          expiresAt: new Date('2030-01-01T00:00:00Z'),
          transactionId,
        },
      });

    it("accepts a link to the owner's own transaction", async () => {
      await expect(draft(alice, aliceTx, 'a')).resolves.toBeDefined();
    });

    it("refuses a link to another user's transaction", async () => {
      expect(await rejected(draft(alice, bobTx, 'b'))).toContain('transaction does not belong');
    });

    it("refuses re-pointing an existing draft at another user's transaction", async () => {
      const pending = await draft(alice, null, 'c');
      const message = await rejected(
        prisma.$executeRaw`UPDATE receipt_drafts SET status = 'CONFIRMED', transaction_id = ${bobTx} WHERE id = ${pending.id}`,
      );
      expect(message).toContain('transaction does not belong');
    });
  });

  describe('npm run db:verify detects what the guards would have stopped', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'scripts', 'sql', 'integrity-checks.sql'),
      'utf8',
    );
    const violations = async (): Promise<Record<string, number>> => {
      const rows = await prisma.$queryRawUnsafe<Array<{ '?column?': string }>>(sql);
      return Object.fromEntries(
        rows.map((r) => {
          const [name, count] = String(Object.values(r)[0]).split('|');
          return [name, Number(count)];
        }),
      );
    };

    it('reports zero violations on clean data', async () => {
      const all = await violations();
      expect(Object.values(all).every((n) => n === 0)).toBe(true);
      expect(Object.keys(all)).toEqual(
        expect.arrayContaining([
          "transactions or budgets that use another user's category",
          "receipt drafts linked to another user's transaction",
        ]),
      );
    });

    it('reports a cross-user row that slipped in while the guard was off (a restored or imported database)', async () => {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE transactions DISABLE TRIGGER transactions_category_owner',
      );
      try {
        await tx(alice, bobCategory, 'smuggled');
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE transactions ENABLE TRIGGER transactions_category_owner',
        );
      }
      const all = await violations();
      expect(all["transactions or budgets that use another user's category"]).toBe(1);
    });
  });
});
