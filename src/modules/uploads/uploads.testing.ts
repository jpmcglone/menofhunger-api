import { UploadGrantsService } from "./upload-grants.service";
import type { AppConfigService } from "../app/app-config.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { PublicProfileCacheService } from "../users/public-profile-cache.service";
import type { UsersMeRealtimeService } from "../users/users-me-realtime.service";
import type { UsersPublicRealtimeService } from "../users/users-public-realtime.service";
import { UploadsArticleAssetsService } from "./uploads-article-assets.service";
import { UploadsPostMediaService } from "./uploads-post-media.service";
import { UploadsStorageService } from "./uploads-storage.service";
import { UploadsService } from "./uploads.service";

/** Wires UploadsService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeUploadsService(
  prisma: PrismaService,
  appConfig: AppConfigService,
  publicProfileCache: PublicProfileCacheService<{
    id: string;
    username: string | null;
  }>,
  usersMeRealtime: UsersMeRealtimeService,
  usersPublicRealtime: UsersPublicRealtimeService,
): UploadsService {
  const storage = new UploadsStorageService(appConfig);
  return new UploadsService(
    prisma,
    appConfig,
    storage,
    publicProfileCache,
    usersMeRealtime,
    usersPublicRealtime,
    new UploadsPostMediaService(
      storage,
      prisma,
      new UploadGrantsService(prisma, storage),
    ),
    new UploadsArticleAssetsService(storage, prisma),
  );
}
