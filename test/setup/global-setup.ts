/**
 * Runs once before the integration/e2e suites: makes sure the (empty) TEST database exists on the
 * PostgreSQL and applies every migration to it, exactly like production would.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import {
  adminDatabaseUrl,
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../../src/testing/db-guard';

export default async function globalSetup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl(process.env);
  assertSafeTestDatabase(testUrl);
  const dbName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));

  const admin = new PrismaClient({ datasourceUrl: adminDatabaseUrl(testUrl) });
  try {
    const found = await admin.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${dbName}) AS exists`;
    if (!found[0]?.exists) {
      // The name is validated by assertSafeTestDatabase (letters/digits/underscore only).
      if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error('unsafe test database name');
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}
