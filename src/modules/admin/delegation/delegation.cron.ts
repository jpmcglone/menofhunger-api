import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { AppConfigService } from "../../app/app-config.service";
import { JobsService } from "../../jobs/jobs.service";
import { JOBS } from "../../jobs/jobs.constants";
@Injectable()
export class DelegationCron {
  constructor(
    private readonly config: AppConfigService,
    private readonly jobs: JobsService,
  ) {}
  @Cron("* * * * *")
  async enqueueSweep() {
    if (!this.config.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(
        JOBS.adminDelegationSweep,
        {},
        "cron-admin-delegation",
        { attempts: 1 },
      );
    } catch {
      /* The next minute retries outbox delivery. */
    }
  }
}
