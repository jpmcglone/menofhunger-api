import { Module } from "@nestjs/common";
import { UploadGrantsModule } from "./upload-grants.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { UsersModule } from "../users/users.module";
import { UploadsController } from "./uploads.controller";
import { UploadsPostMediaService } from "./uploads-post-media.service";
import { UploadsArticleAssetsService } from "./uploads-article-assets.service";
import { UploadsService } from "./uploads.service";

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, UploadGrantsModule],
  controllers: [UploadsController],
  providers: [
    UploadsPostMediaService,
    UploadsArticleAssetsService,
    UploadsService,
  ],
  exports: [UploadsService],
})
export class UploadsModule {}
