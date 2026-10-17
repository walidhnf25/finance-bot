import { PrismaService } from '../../src/database/prisma.service';
import { assertSafeTestDatabase } from '../../src/testing/db-guard';
import { CategorySeederService } from '../../src/modules/category/category-seeder.service';

/** A connected PrismaService for the test database (guard re-checked on every use). */
export async function connectTestPrisma(): Promise<PrismaService> {
  assertSafeTestDatabase(process.env.DATABASE_URL ?? '');
  const prisma = new PrismaService();
  await prisma.$connect();
  return prisma;
}

/** Empty every table (keeps the migration history), then re-create the system categories. */
export async function resetDatabase(prisma: PrismaService, seed = true): Promise<void> {
  assertSafeTestDatabase(process.env.DATABASE_URL ?? '');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "audit_events","receipt_drafts","conversations","budgets","transfers","transactions","categories","users" RESTART IDENTITY CASCADE`,
  );
  if (seed) await new CategorySeederService(prisma).seed();
}

let counter = 0;
/** A user row with a unique telegram id, for tests that need an owner. */
export async function createUser(prisma: PrismaService, name = 'tester'): Promise<{ id: string }> {
  counter += 1;
  return prisma.user.create({
    data: { telegramId: `${Date.now()}${counter}`, displayName: name, chatId: String(counter) },
    select: { id: true },
  });
}
