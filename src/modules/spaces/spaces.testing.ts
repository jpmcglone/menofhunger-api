import type { AppConfigService } from "../app/app-config.service";
import type { JobsService } from "../jobs/jobs.service";
import type { LinkMetadataService } from "../link-metadata/link-metadata.service";
import type { NotificationWriterFanoutService } from "../notifications";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { SideEffectsService } from "../side-effects/side-effects.service";
import type { PosthogService } from "../../common/posthog/posthog.service";
import { SpacesScheduleService } from "./spaces-schedule.service";
import type { SpacesPresenceService } from "./spaces-presence.service";
import { SpacesViewService } from "./spaces-view.service";
import { SpacesService } from "./spaces.service";

/** Wires SpacesService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeSpacesService(
  prisma: PrismaService,
  appConfig: AppConfigService,
  spacesPresence: SpacesPresenceService,
  sideEffects: SideEffectsService,
  jobs: JobsService,
  realtime: PresenceRealtimeService,
  notifications: Pick<
    NotificationWriterFanoutService,
    "upsertSpaceScheduleNotification" | "listRecipientIdsForSpaceNotification"
  >,
  linkMetadata: LinkMetadataService,
  posthog: PosthogService,
): SpacesService {
  const view = new SpacesViewService(
    prisma,
    appConfig,
    spacesPresence,
    linkMetadata,
    realtime,
  );
  const schedule = new SpacesScheduleService(
    view,
    jobs,
    linkMetadata,
    posthog,
    prisma,
    sideEffects,
    spacesPresence,
  );
  return new SpacesService(
    prisma,
    sideEffects,
    notifications,
    posthog,
    view,
    schedule,
  );
}
