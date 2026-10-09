import { Inject } from "@nestjs/common";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsMutationWriteService } from "./posts-mutation-write.service";
import { PostsMutationEditsService } from "./posts-mutation-edits.service";
import {
  parseMarvModeHeader,
  CreateMediaItem,
  createSchema,
  updateSchema,
  publishFromOnlyMeSchema,
} from "./posts.schemas";
import { isSiteAdminViewer } from "../viewer/site-admin";
import type { CrosspostMode } from "@prisma/client";
import { PickaxCrosspostService } from "../pickax/pickax-crosspost.service";
import { XCrosspostService } from "../x/x-crosspost.service";
import {
  Body,
  Controller,
  Delete,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard } from "../auth/auth-public-api";
import { AppConfigService } from "../app/app-config.service";
import { CurrentUserId } from "../users/users.decorator";
import { toPostDto } from "./post.dto";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";

@ApiTags("Feed & Posts")
@Controller("posts")
export class PostsPublicationController {
  constructor(
    @Inject(PostsViewerEnrichmentService)
    private readonly postsEnrichment: Pick<
      PostsViewerEnrichmentService,
      "viewerContext"
    >,
    @Inject(PostsMutationWriteService)
    private readonly postsMutationWrite: Pick<
      PostsMutationWriteService,
      "createPost"
    >,
    @Inject(PostsMutationEditsService)
    private readonly postsMutationEdits: Pick<
      PostsMutationEditsService,
      "deletePost" | "publishFromOnlyMe" | "updatePost"
    >,
    private readonly appConfig: AppConfigService,
    private readonly pickax: PickaxCrosspostService,
    private readonly x: XCrosspostService,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("postCreate", 30),
      ttl: rateLimitTtl("postCreate", 60),
    },
  })
  @Post()
  async create(
    @Body() body: unknown,
    @CurrentUserId() userId: string,
    @Headers("x-marv-mode") marvModeHeader?: string,
  ) {
    const parsed = createSchema.parse(body);
    const marvMode = parseMarvModeHeader(marvModeHeader);
    const media = (parsed.media ?? null) as CreateMediaItem[] | null;
    const poll = parsed.poll
      ? (() => {
          const d = parsed.poll!.duration;
          const totalSeconds =
            d.days * 24 * 60 * 60 + d.hours * 60 * 60 + d.minutes * 60;
          return {
            endsAt: new Date(Date.now() + totalSeconds * 1000),
            options: parsed.poll!.options.map((o) => ({
              text: (o.text ?? "").trim(),
              image: o.image
                ? {
                    r2Key: o.image.r2Key,
                    width:
                      typeof o.image.width === "number" ? o.image.width : null,
                    height:
                      typeof o.image.height === "number"
                        ? o.image.height
                        : null,
                    alt: (o.image.alt ?? "").trim() || null,
                  }
                : null,
            })),
          };
        })()
      : null;
    const { post: created, streakReward } =
      await this.postsMutationWrite.createPost({
        crosspost:
          parsed.crosspost ??
          (parsed.crossPostToPickax ? { pickax: "native" } : undefined),
        userId,
        body: (parsed.body ?? "").trim(),
        visibility: parsed.visibility ?? "public",
        parentId: parsed.parent_id ?? null,
        communityGroupId: parsed.community_group_id ?? null,
        mentions: parsed.mentions ?? null,
        media,
        poll,
        marvMode,
      });

    const pickaxMode: CrosspostMode | null =
      parsed.crosspost?.pickax ?? (parsed.crossPostToPickax ? "native" : null);
    const xMode = parsed.crosspost?.x ?? null;
    const pickax = pickaxMode
      ? await this.pickax.requestPostCrosspost(userId, created.id, pickaxMode)
      : null;
    const x = xMode
      ? await this.x.requestPostCrosspost(userId, created.id, xMode)
      : null;

    const viewer = await this.postsEnrichment.viewerContext(userId);
    const viewerHasAdmin = isSiteAdminViewer(viewer);
    return {
      data: {
        pickax,
        crossposts: { pickax, x },
        post: toPostDto(created, this.appConfig.r2()?.publicBaseUrl ?? null, {
          viewerHasBoosted: false,
          includeInternal: viewerHasAdmin,
          viewerIsAuthor: true,
        }),
        streakReward: streakReward ?? null,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete(":id")
  async delete(@Param("id") id: string, @CurrentUserId() userId: string) {
    const result = await this.postsMutationEdits.deletePost({
      userId,
      postId: id,
    });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @CurrentUserId() userId: string,
  ) {
    const parsed = updateSchema.parse(body);
    const viewer = await this.postsEnrichment.viewerContext(userId);
    const viewerHasAdmin = isSiteAdminViewer(viewer);
    const updated = await this.postsMutationEdits.updatePost({
      userId,
      postId: id,
      body: (parsed.body ?? "").trim(),
      isSiteAdmin: viewerHasAdmin,
    });
    await this.pickax.requestPostUpdate(userId, id);

    return {
      data: toPostDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null, {
        viewerHasBoosted: false,
        includeInternal: viewerHasAdmin,
      }),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("postCreate", 30),
      ttl: rateLimitTtl("postCreate", 60),
    },
  })
  @Post(":id/publish-from-only-me")
  async publishFromOnlyMe(
    @Param("id") id: string,
    @Body() body: unknown,
    @CurrentUserId() userId: string,
  ) {
    const parsed = publishFromOnlyMeSchema.parse(body);
    const created = await this.postsMutationEdits.publishFromOnlyMe({
      userId,
      sourcePostId: id,
      body: typeof parsed.body === "string" ? parsed.body.trim() : null,
      visibility: parsed.visibility,
      media: parsed.media ?? null,
    });
    const viewer = await this.postsEnrichment.viewerContext(userId);
    const viewerHasAdmin = isSiteAdminViewer(viewer);
    return {
      data: toPostDto(created, this.appConfig.r2()?.publicBaseUrl ?? null, {
        viewerHasBoosted: false,
        includeInternal: viewerHasAdmin,
      }),
    };
  }
}
