import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { openSecret, sealSecret } from '../../common/crypto/secret-box';

/** Provider state is encrypted at rest; token strings appear only as hashes in keys. */
export function partnerAdapter(prisma: PrismaService, secret: string) {
  return class PartnerAdapter {
    constructor(private readonly kind: string) {}
    private key(id: string) {
      return `${this.kind}:${createHash('sha256').update(id).digest('hex')}`;
    }
    async upsert(id: string, payload: Record<string, any>, expiresIn: number) {
      const data = {
        kind: this.kind,
        payloadEnc: sealSecret(JSON.stringify(payload), secret),
        grantId: payload.grantId ?? null,
        uid: payload.uid ?? null,
        userCode: payload.userCode ?? null,
        expiresAt: new Date(Date.now() + (this.kind === 'RefreshToken' ? Math.max(expiresIn, 180 * 86400) : expiresIn) * 1000),
      };
      await prisma.partnerOidcRecord.upsert({
        where: { key: this.key(id) },
        create: { key: this.key(id), ...data },
        update: data,
      });
    }
    private decode(row: { payloadEnc: string; expiresAt: Date; consumedAt: Date | null } | null) {
      if (!row || row.expiresAt <= new Date()) return undefined;
      return {
        ...JSON.parse(openSecret(row.payloadEnc, secret)),
        ...(row.consumedAt ? { consumed: Math.floor(row.consumedAt.getTime() / 1000) } : {}),
      };
    }
    async find(id: string) {
      return this.decode(await prisma.partnerOidcRecord.findUnique({ where: { key: this.key(id) } }));
    }
    async findByUid(uid: string) {
      return this.decode(await prisma.partnerOidcRecord.findFirst({ where: { kind: this.kind, uid } }));
    }
    async findByUserCode(userCode: string) {
      return this.decode(await prisma.partnerOidcRecord.findFirst({ where: { kind: this.kind, userCode } }));
    }
    async consume(id: string) {
      const result = await prisma.partnerOidcRecord.updateMany({
        where: { key: this.key(id), consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (!result.count) {
        const { errors } = require('oidc-provider');
        throw new errors.InvalidGrant('Authorization credential was already consumed.');
      }
    }
    async destroy(id: string) {
      await prisma.partnerOidcRecord.deleteMany({ where: { key: this.key(id) } });
    }
    async revokeByGrantId(grantId: string) {
      await prisma.$transaction([
        prisma.partnerOidcRecord.deleteMany({ where: { grantId } }),
        prisma.partnerGrant.updateMany({ where: { id: grantId }, data: { revokedAt: new Date() } }),
      ]);
    }
  };
}
