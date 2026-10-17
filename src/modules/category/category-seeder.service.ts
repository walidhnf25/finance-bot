import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { SeedCategory, SYSTEM_CATEGORIES } from './seed-data';

/**
 * Deterministic id (e.g. `system-expense-pemasukan-lain`). The id is the primary key, so seeding
 * is idempotent even when two processes start at once: the second insert is simply skipped.
 */
export function systemCategoryId(category: Pick<SeedCategory, 'type' | 'name'>): string {
  const slug = category.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `system-${category.type.toLowerCase()}-${slug}`;
}

/**
 * Ensures the system categories exist at startup so automatic categorisation works out of the
 * box. Rows already in the database are left untouched, so keywords a user edited are preserved.
 * Failures are logged, never fatal.
 */
@Injectable()
export class CategorySeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CategorySeederService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const { count } = await this.seed();
      if (count > 0) this.logger.log(`Seeded ${count} system categories`);
    } catch {
      this.logger.error('Category seeding failed (non-fatal)');
    }
  }

  /** Insert any missing system category. Returns how many were created. */
  seed(): Promise<{ count: number }> {
    return this.prisma.category.createMany({
      data: SYSTEM_CATEGORIES.map((c) => ({
        id: systemCategoryId(c),
        userId: null,
        name: c.name,
        type: c.type,
        icon: c.icon,
        isSystem: true,
        keywords: c.keywords,
      })),
      skipDuplicates: true,
    });
  }
}
