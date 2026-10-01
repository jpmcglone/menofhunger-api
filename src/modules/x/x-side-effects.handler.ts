import { Injectable, OnModuleInit } from '@nestjs/common';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { OutboundService, OutboundAttentionError } from '../outbound/outbound.service';
import { XCrosspostService } from './x-crosspost.service';
import { XConnectionService } from './x-connection.service';
import { XApiClient } from './x-api.client';
import { PrismaService } from '../prisma/prisma.service';
@Injectable()
export class XSideEffectsHandler implements OnModuleInit {
  constructor(private readonly registry: SideEffectsRegistry, private readonly crosspost: XCrosspostService,
    private readonly outbound: OutboundService, private readonly connections: XConnectionService,
    private readonly api: XApiClient, private readonly prisma: PrismaService) {}
  onModuleInit() {
    this.registry.register('x.post.sync', async p => {
      const mapping = await this.prisma.xCrosspost.findUnique({ where: { kind_localId: { kind: 'post', localId: p.postId } } });
      if (mapping) await this.outbound.ensure(mapping.userId, 'x', 'post', p.postId, mapping.mode);
    });
    this.registry.register('x.article.sync', async p => {
      const mapping = await this.prisma.xCrosspost.findUnique({ where: { kind_localId: { kind: 'article', localId: p.articleId } } });
      if (mapping) await this.outbound.ensure(mapping.userId, 'x', 'article', p.articleId, mapping.mode);
    });
    this.outbound.register('x', {
      send: async row => {
        if (row.action === 'update') throw new OutboundAttentionError('X copies cannot be edited automatically.');
        const kind = row.resourceKind as 'post' | 'article';
        await this.prisma.xCrosspost.upsert({ where: { kind_localId: { kind, localId: row.resourceId } }, create: { userId: row.userId, kind, localId: row.resourceId, mode: row.mode as 'link' | 'native' }, update: {} });
        if (kind === 'post') await this.crosspost.syncPost(row.resourceId, row.connectionGeneration); else await this.crosspost.syncArticle(row.resourceId, row.connectionGeneration);
      },
      remove: async row => {
        if (!row.remoteId) return;
        const connection = await this.connections.getActiveConnection(row.userId);
        if (!connection || connection.generation !== row.connectionGeneration) throw new Error('Original connection unavailable.');
        await this.api.deletePost(await this.connections.accessTokenFor(connection), row.remoteId);
      },
    });
  }
}
