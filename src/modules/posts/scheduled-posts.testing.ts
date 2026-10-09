import type { AppConfigService } from '../app/app-config.service';
import type { PickaxCrosspostService } from '../pickax/pickax-crosspost.service';
import type { PresenceRealtimeService } from '../presence/presence-realtime.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { XCrosspostService } from '../x/x-crosspost.service';
import type { PostsMutationWriteService } from './posts-mutation-write.service';
import { ScheduledPostsPublishService } from './scheduled-posts-publish.service';
import { ScheduledPostsUpdateService } from './scheduled-posts-update.service';
import { ScheduledPostsService } from './scheduled-posts.service';

/** Wires ScheduledPostsService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeScheduledPostsService(
  prisma: PrismaService,
  mutation: Pick<PostsMutationWriteService, 'createPost'>,
  realtime: PresenceRealtimeService,
  appConfig: AppConfigService,
  pickax: PickaxCrosspostService,
  x: XCrosspostService,
): ScheduledPostsService {
  return new ScheduledPostsService(
    prisma,
    appConfig,
    new ScheduledPostsUpdateService(appConfig, prisma),
    new ScheduledPostsPublishService(appConfig, mutation as PostsMutationWriteService, pickax, prisma, realtime, x),
  );
}
