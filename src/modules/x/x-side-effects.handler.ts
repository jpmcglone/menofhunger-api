import { Injectable, OnModuleInit } from '@nestjs/common';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { XCrosspostService } from './x-crosspost.service';

@Injectable()
export class XSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly registry: SideEffectsRegistry,
    private readonly crosspost: XCrosspostService,
  ) {}

  onModuleInit(): void {
    this.registry.register('x.post.sync', (payload) => this.crosspost.syncPost(payload.postId));
    this.registry.register('x.article.sync', (payload) => this.crosspost.syncArticle(payload.articleId));
  }
}
