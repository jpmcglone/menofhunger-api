import { Inject } from '@nestjs/common';
import { PostsViewerEnrichmentService } from '../posts/posts-viewer-enrichment.service';
import { Injectable } from "@nestjs/common";
import type { PostVisibility } from "@prisma/client";
import { AppConfigService } from "../app/app-config.service";
import { MutesService } from "../mutes/mutes.service";

import { ViewerContextService, type ViewerContext } from "../viewer/viewer-context.service";
import { BOARD_VISIBILITIES, EDIT_WINDOW_MS, MAX_EDITS } from "./board.constants";

/** Who can see, edit, or is hidden from whom on the Board. */
@Injectable()
export class BoardAccessService {
  constructor(
    @Inject(PostsViewerEnrichmentService) private readonly postsEnrichment: Pick<PostsViewerEnrichmentService, 'viewerBlockSets'>,
    private readonly viewerContext: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly mutes: MutesService,
  ) {}

  /** Authors kept off the viewer's Board lists: blocks in either direction, plus people the viewer muted. */
  async hiddenAuthorIds(
    viewer: ViewerContext | null,
    opts: { includeMuted: boolean },
  ): Promise<string[]> {
    if (!viewer) return [];
    const [blocks, muted] = await Promise.all([
      this.postsEnrichment.viewerBlockSets(viewer.id),
      opts.includeMuted
        ? this.mutes.mutedIds(viewer.id)
        : Promise.resolve(new Set<string>()),
    ]);
    return [
      ...new Set([
        ...blocks.blockedByViewer,
        ...blocks.viewerBlockedBy,
        ...muted,
      ]),
    ];
  }

  get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  canRead(
    viewer: ViewerContext | null,
    row: { userId: string; visibility: PostVisibility },
  ): boolean {
    if (row.visibility === "public") return true;
    if (!viewer) return false;
    if (viewer.siteAdmin || viewer.id === row.userId) return true;
    return this.viewerContext
      .allowedPostVisibilities(viewer)
      .includes(row.visibility);
  }

  readableVisibilities(viewer: ViewerContext | null): PostVisibility[] {
    if (viewer?.siteAdmin) return BOARD_VISIBILITIES;
    return this.viewerContext
      .allowedPostVisibilities(viewer)
      .filter((v) => v !== "onlyMe");
  }

  canEdit(
    viewer: ViewerContext | null,
    row: { userId: string; createdAt: Date; editCount: number },
  ): boolean {
    if (!viewer) return false;
    if (viewer.siteAdmin) return true;
    if (viewer.id !== row.userId) return false;
    return (
      Date.now() <= row.createdAt.getTime() + EDIT_WINDOW_MS &&
      row.editCount < MAX_EDITS
    );
  }
}
