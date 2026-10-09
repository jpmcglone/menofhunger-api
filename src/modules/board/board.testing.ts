import type { AppConfigService } from "../app/app-config.service";
import type { MutesService } from "../mutes/mutes.service";
import type { PostsReadService } from "../posts-read/posts-read.service";
import type { PostsWriteService } from "../posts-read/posts-write.service";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { SideEffectsService } from "../side-effects/side-effects.service";
import type { ViewerContextService } from "../viewer/viewer-context.service";
import { BoardAccessService } from "./board-access.service";
import { BoardArticleThreadsService } from "./board-article-threads.service";
import { BoardCommentsService } from "./board-comments.service";
import { BoardInsightsService } from "./board-insights.service";
import { BoardThreadsReadService } from "./board-threads-read.service";
import { BoardService } from "./board.service";

type BoardPostCollaborators =
  ConstructorParameters<typeof BoardService>[1] &
  ConstructorParameters<typeof BoardService>[2] &
  ConstructorParameters<typeof BoardAccessService>[0] &
  ConstructorParameters<typeof BoardThreadsReadService>[1] &
  ConstructorParameters<typeof BoardCommentsService>[2] &
  ConstructorParameters<typeof BoardCommentsService>[3] &
  ConstructorParameters<typeof BoardArticleThreadsService>[2];

/** Wires BoardService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeBoardService(
  prisma: PrismaService,
  posts: BoardPostCollaborators,
  viewerContext: ViewerContextService,
  appConfig: AppConfigService,
  realtime: PresenceRealtimeService,
  sideEffects: SideEffectsService,
  mutes: MutesService,
  postsRead: PostsReadService,
  postsWrite: PostsWriteService,
): BoardService {
  const access = new BoardAccessService(posts, viewerContext, appConfig, mutes);
  const threads = new BoardThreadsReadService(access, posts, postsRead, prisma, viewerContext);
  const insights = new BoardInsightsService(threads, access, postsRead, prisma, viewerContext);
  const comments = new BoardCommentsService(threads, access, posts, posts, postsRead, viewerContext);
  const articleThreads = new BoardArticleThreadsService(insights, appConfig, posts, postsRead, postsWrite, prisma, realtime, sideEffects);
  return new BoardService(prisma, posts, posts, viewerContext, appConfig, realtime, sideEffects, postsRead, postsWrite, access, threads, comments, articleThreads, insights);
}
