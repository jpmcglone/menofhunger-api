import { Injectable } from '@nestjs/common';
import { randomBytes, createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import type { EmailActionTokenPurpose } from '@prisma/client';

function base64Url(bytes: Buffer): string {
  // Node 20 supports base64url encoding.
  return bytes.toString('base64url');
}

@Injectable()
export class EmailActionTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  private tokenHash(rawToken: string): string {
    // Use a stable secret already required in prod.
    const secret = this.appConfig.sessionHmacSecret();
    return createHmac('sha256', secret).update(String(rawToken ?? '')).digest('hex');
  }

  async issue(params: {
    userId: string;
    purpose: EmailActionTokenPurpose;
    email: string | null;
    expiresAt: Date;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = base64Url(randomBytes(32));
    const tokenHash = this.tokenHash(token);
    await this.prisma.emailActionToken.create({
      data: {
        userId: params.userId,
        purpose: params.purpose,
        tokenHash,
        email: params.email,
        expiresAt: params.expiresAt,
      },
    });
    return { token, expiresAt: params.expiresAt };
  }

  async consume(params: {
    purpose: EmailActionTokenPurpose;
    token: string;
    userId?: string;
  }): Promise<
    | {
        id: string;
        userId: string;
        email: string | null;
        expiresAt: Date;
        consumedAt: Date | null;
      }
    | null
  > {
    const hash = this.tokenHash(params.token);
    const now = new Date();
    const row = await this.prisma.emailActionToken.findFirst({
      where: {
        purpose: params.purpose,
        tokenHash: hash,
        ...(params.userId ? { userId: params.userId } : {}),
        consumedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true, userId: true, email: true, expiresAt: true, consumedAt: true },
    });
    if (!row) return null;

    await this.prisma.emailActionToken.update({
      where: { id: row.id },
      data: { consumedAt: now },
    });
    return row;
  }

  async invalidateAll(params: { userId: string; purpose: EmailActionTokenPurpose }): Promise<void> {
    await this.prisma.emailActionToken.updateMany({
      where: { userId: params.userId, purpose: params.purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
}

