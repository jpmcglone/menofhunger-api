/** Generate partner-only OpenAPI without connecting to application databases or services. */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PartnerController, PartnerGuard } from '../src/modules/partner/partner.controller';
import { PartnerReadService } from '../src/modules/partner/partner-read.service';
import { PartnerRateService } from '../src/modules/partner/partner-rate.service';
import { PartnerOAuthService } from '../src/modules/partner/partner-oauth.service';
import { PartnerAccessService } from '../src/modules/partner/partner-access.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { RedisService } from '../src/modules/redis/redis.service';
import { AppConfigService } from '../src/modules/app/app-config.service';
@Module({ controllers: [PartnerController], providers: [PartnerReadService, PartnerRateService, PartnerOAuthService, PartnerAccessService, RedisService, AppConfigService, PrismaService].map(provide => ({ provide, useValue: {} })).concat([{ provide: PartnerGuard as any, useValue: {} }]) })
class ReferenceModule {}
async function main() {
  const app = await NestFactory.create(ReferenceModule, { logger: false, abortOnError: false });
  try {
    app.setGlobalPrefix('v1');
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Men of Hunger Partner API').setVersion('1').addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'opaque' }, 'partner').build());
    if (Object.keys(doc.paths).some(path => !path.startsWith('/v1/partner/'))) throw new Error('Non-partner route in reference');
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        if (operations[method] && !(path === '/v1/partner/connection/continue' && method === 'post')) {
          throw new Error(`Partner content writes are forbidden: ${method.toUpperCase()} ${path}`);
        }
      }
    }
    const json = `${JSON.stringify(doc, null, 2)}\n`;
    const path = resolve('docs/partners/openapi.json');
    if (process.argv.includes('--check')) {
      if (readFileSync(path, 'utf8') !== json) throw new Error('Partner OpenAPI drift: run npm run emit:partner-reference');
    } else writeFileSync(path, json);
    console.log(`Partner OpenAPI: ${Object.keys(doc.paths).length} paths, no internal/admin routes.`);
  } finally { await app.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
