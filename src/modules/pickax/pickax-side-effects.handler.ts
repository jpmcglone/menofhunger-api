import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { OutboundService, OutboundAttentionError } from '../outbound/outbound.service';
import { PickaxCrosspostService } from './pickax-crosspost.service';
import { PickaxConnectionService } from './pickax-connection.service';
import { PickaxApiClient } from './pickax-api.client';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
@Injectable()
export class PickaxSideEffectsHandler implements OnModuleInit {
  constructor(private readonly registry: SideEffectsRegistry, private readonly crosspost: PickaxCrosspostService,
    private readonly outbound: OutboundService, private readonly connections: PickaxConnectionService,
    private readonly api: PickaxApiClient, private readonly cfg: AppConfigService, private readonly prisma: PrismaService) {}
  onModuleInit() {
    this.registry.register('pickax.post.sync', async p => {
      const mapping = await this.prisma.pickaxCrosspost.findUnique({ where: { kind_localId: { kind: 'post', localId: p.postId } } });
      if (mapping) await this.outbound.ensure(mapping.userId, 'pickax', 'post', p.postId, mapping.mode);
    });
    this.registry.register('pickax.article.sync', async p => {
      const mapping = await this.prisma.pickaxCrosspost.findUnique({ where: { kind_localId: { kind: 'article', localId: p.articleId } } });
      if (mapping) await this.outbound.ensure(mapping.userId, 'pickax', 'article', p.articleId, mapping.mode);
    });
    this.outbound.register('pickax', {
      send: async row => {
        const kind = row.resourceKind as 'post' | 'article';
        await this.prisma.pickaxCrosspost.upsert({ where: { kind_localId: { kind, localId: row.resourceId } }, create: { userId: row.userId, kind, localId: row.resourceId, mode: row.mode as 'link' | 'native' }, update: {} });
        if (kind === 'post') await this.crosspost.syncPost(row.resourceId, row.action === 'create', row.connectionGeneration);
        else await this.crosspost.syncArticle(row.resourceId, row.action === 'create', row.connectionGeneration);
      },
      remove: async row => {
        if (!row.remoteId) return;
        if (!this.cfg.partner().pickaxDelete) throw new OutboundAttentionError('Pickax does not support removal yet. Remove the remote copy manually.');
        const connection = await this.connections.getActiveConnection(row.userId);
        if (!connection || connection.generation !== row.connectionGeneration) throw new Error('Original connection unavailable.');
        const token = await this.connections.accessTokenFor(connection);
        await this.api.deleteContent(token, row.resourceKind === 'article' && row.mode === 'native' ? 'articles' : 'posts', row.remoteId);
      },
    });
  }
}
