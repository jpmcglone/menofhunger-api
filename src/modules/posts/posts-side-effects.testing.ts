import type { EmbeddingsService } from "../embeddings/embeddings.service";
import type { JobsService } from "../jobs/jobs.service";
import type { LinkMetadataService } from "../link-metadata/link-metadata.service";
import type { MarvinAddressingService } from "../marvin/services/marvin-addressing.service";
import type { MarvinBotIdentityService } from "../marvin/services/marvin-bot-identity.service";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AppConfigService } from "../app/app-config.service";
import type { SideEffectsRegistry } from "../side-effects/side-effects.registry";
import type { SideEffectsService } from "../side-effects/side-effects.service";
import type { PostsTopicsClassifyService } from "./posts-topics-classify.service";
import { PostsCreatedEffectsService } from "./posts-created-effects.service";
import { PostsEngagementEffectsService } from "./posts-engagement-effects.service";
import { PostsSideEffectsHandler } from "./posts-side-effects.handler";

/** Wires the posts side-effects handler and its collaborators by hand for unit tests. */
export function makePostsSideEffectsHandler(
  prisma: PrismaService,
  notifications: ConstructorParameters<
    typeof PostsEngagementEffectsService
  >[1] &
    ConstructorParameters<typeof PostsEngagementEffectsService>[2] &
    ConstructorParameters<typeof PostsCreatedEffectsService>[1] &
    ConstructorParameters<typeof PostsCreatedEffectsService>[2] &
    ConstructorParameters<typeof PostsSideEffectsHandler>[1] &
    ConstructorParameters<typeof PostsSideEffectsHandler>[2] &
    ConstructorParameters<typeof PostsSideEffectsHandler>[3],
  presenceRealtime: PresenceRealtimeService,
  appConfig: AppConfigService,
  jobs: JobsService,
  marvIdentity: MarvinBotIdentityService,
  linkMetadata: LinkMetadataService,
  registry: SideEffectsRegistry,
  sideEffects: SideEffectsService,
  topicsClassify: PostsTopicsClassifyService,
  marvAddressing?: MarvinAddressingService,
  embeddings?: EmbeddingsService,
  contentScreen?: ConstructorParameters<typeof PostsSideEffectsHandler>[16],
) {
  const engagement = new PostsEngagementEffectsService(
    prisma,
    notifications,
    notifications,
    presenceRealtime,
    topicsClassify,
    embeddings,
  );
  const created = new PostsCreatedEffectsService(
    prisma,
    notifications,
    notifications,
    presenceRealtime,
    appConfig,
    jobs,
    marvIdentity,
    sideEffects,
    marvAddressing,
  );
  return new PostsSideEffectsHandler(
    prisma,
    notifications,
    notifications,
    notifications,
    presenceRealtime,
    appConfig,
    jobs,
    marvIdentity,
    linkMetadata,
    registry,
    sideEffects,
    topicsClassify,
    engagement,
    created,
    marvAddressing,
    embeddings,
    contentScreen,
  );
}
