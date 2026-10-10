import type { AppConfigService } from "../app/app-config.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { PublicProfileCacheService } from "../users/public-profile-cache.service";
import { AdminImageReviewActionsService } from "./admin-image-review-actions.service";
import { AdminImageReferencesService } from "./admin-image-review-references.service";
import { AdminImageReviewStorageService } from "./admin-image-review-storage.service";
import { AdminImageReviewSyncService } from "./admin-image-review-sync.service";
import { AdminImageReviewService } from "./admin-image-review.service";

/** Wires AdminImageReviewService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeAdminImageReviewService(
  prisma: PrismaService,
  cfg: AppConfigService,
  publicProfileCache: PublicProfileCacheService<{
    id: string;
    username: string | null;
  }>,
): AdminImageReviewService {
  const storage = new AdminImageReviewStorageService(cfg);
  const references = new AdminImageReferencesService(storage, cfg, prisma);
  const sync = new AdminImageReviewSyncService(cfg, prisma, storage);
  const actions = new AdminImageReviewActionsService(
    storage,
    references,
    sync,
    prisma,
    publicProfileCache,
    {
      rebroadcastMessage: async () => undefined,
    },
    {
      publishMediaChange: async () => undefined,
    },
  );
  return new AdminImageReviewService(prisma, cfg, storage, references, actions);
}
