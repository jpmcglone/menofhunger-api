import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { BoardTaggerService } from './board-tagger.service';

@Injectable()
export class BoardSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly registry: SideEffectsRegistry,
    private readonly tagger: BoardTaggerService,
  ) {}

  onModuleInit(): void {
    this.registry.register('board.thread.tag', (p) => this.onTag(p));
  }

  private async onTag(payload: SideEffectPayloads['board.thread.tag']): Promise<void> {
    await this.tagger.tagThread(payload.threadId);
  }
}
