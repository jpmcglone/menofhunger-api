import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { AppConfigModule } from "../app/app-config.module";
import { EmailLifecycleService } from "./email-lifecycle.service";
import { EmailLifecycleCron } from "./email-lifecycle.cron";

@Module({
  imports: [PrismaModule, EmailModule, AppConfigModule],
  providers: [EmailLifecycleService, EmailLifecycleCron],
})
export class EmailLifecycleModule {}
