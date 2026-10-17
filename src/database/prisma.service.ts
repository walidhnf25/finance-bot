import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The single PostgreSQL connection pool. The app stays up if the database is down at boot
 * (health/readiness report it); individual requests then fail with a sanitised error.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ log: [{ emit: 'event', level: 'error' }] });
    (this as PrismaClient<Prisma.PrismaClientOptions, 'error'>).$on('error', (e) => {
      // Prisma error text can echo query parameters: log only the target, never the message body.
      this.logger.error({ target: e.target }, 'Database error event');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      this.logger.error('Could not connect to PostgreSQL at startup; retrying on first query');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap connectivity probe used by readiness checks. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}

/** True for a unique-constraint violation (optionally on one of the given columns). */
export function isUniqueViolation(err: unknown, columns?: string[]): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!columns) return true;
  const target = (err.meta?.target as string[] | string | undefined) ?? [];
  const fields = Array.isArray(target) ? target : [target];
  return columns.every((c) => fields.includes(c));
}
