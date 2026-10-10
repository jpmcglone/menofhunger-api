import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { UploadsStorageService } from "./uploads-storage.service";
import { UploadGrantsService } from "./upload-grants.service";

/** Storage and upload authorization; deliberately independent of users/messages modules. */
@Module({
  imports: [PrismaModule],
  providers: [UploadsStorageService, UploadGrantsService],
  exports: [UploadsStorageService, UploadGrantsService],
})
export class UploadGrantsModule {}
