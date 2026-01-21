import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    const retries = Number(process.env.PRISMA_CONNECT_RETRIES ?? '20');
    const delayMs = Number(process.env.PRISMA_CONNECT_RETRY_DELAY_MS ?? '500');

    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (err) {
        lastError = err;
        // Give Postgres a moment to come up (especially when using docker compose).
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw new Error(
      `Prisma could not connect to the database after ${retries} attempts. ` +
        `Is Postgres running and is DATABASE_URL correct?\n` +
        `Last error: ${String((lastError as Error)?.message ?? lastError)}`,
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

