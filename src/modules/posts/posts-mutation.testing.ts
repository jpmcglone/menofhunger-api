import { PostsBoardWritePolicy } from "./posts-board-write.policy";
import { PostsCheckinWriteService } from "./posts-checkin-write.service";
import { PostsQuoteWriteService } from "./posts-quote-write.service";
import { PostsWriteAuthorizationService } from "./posts-write-authorization.service";
import { PostsWritePersistenceService } from "./posts-write-persistence.service";
import { PostsMutationEditsService } from "./posts-mutation-edits.service";
import { PostsMutationSupportService } from "./posts-mutation-support.service";
import { PostsMutationWriteService } from "./posts-mutation-write.service";
import { PostsWriteAfterCommitService } from "./posts-write-after-commit.service";

type SupportArgs = ConstructorParameters<typeof PostsMutationSupportService>;

/**
 * Wires the post write services by hand for unit tests (the module does this through DI).
 * `args` are the shared constructor dependencies in `PostsMutationSupportService` order.
 */
export function makePostsMutationServices(...args: SupportArgs) {
  const [
    prisma,
    presenceRealtime,
    cacheInvalidation,
    appConfig,
    postViews,
    posthog,
    viewerContext,
    enrichment,
    ranking,
    ,
    siteConfig,
    sideEffects,
  ] = args;
  const support = new PostsMutationSupportService(...args);
  const afterCommit = new PostsWriteAfterCommitService(
    appConfig,
    cacheInvalidation,
    posthog,
    postViews,
    presenceRealtime,
    ranking,
    sideEffects,
  );
  const checkins = new PostsCheckinWriteService();
  const board = new PostsBoardWritePolicy(appConfig, support);
  const authorization = new PostsWriteAuthorizationService(
    prisma,
    appConfig,
    viewerContext,
    enrichment,
    siteConfig,
    support,
    board,
    checkins,
  );
  const quotes = new PostsQuoteWriteService(support);
  const persistence = new PostsWritePersistenceService(
    prisma,
    quotes,
    checkins,
  );
  const write = new PostsMutationWriteService(
    prisma,
    appConfig,
    support,
    authorization,
    persistence,
    afterCommit,
  );
  const edits = new PostsMutationEditsService(...args, support, write);
  return { support, write, edits };
}
