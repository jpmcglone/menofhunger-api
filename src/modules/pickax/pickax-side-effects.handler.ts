import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { PickaxCrosspostService } from './pickax-crosspost.service';

@Injectable()
export class PickaxSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly registry: SideEffectsRegistry,
    private readonly crosspost: PickaxCrosspostService,
  ) {}

  onModuleInit(): void {
    this.registry.register('pickax.post.sync', (p) => this.crosspost.syncPost(p.postId, p.create));
    this.registry.register('pickax.article.sync', (p) => this.crosspost.syncArticle(p.articleId, p.create));
  }
}
