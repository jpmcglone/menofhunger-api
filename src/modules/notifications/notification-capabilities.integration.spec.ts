import { AuthGuard } from "../auth/auth-public-api";
import { Test } from "@nestjs/testing";
import { NotificationsController } from "./notifications.controller";
import { NotificationQueryService } from "./notification-query.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationReadSubjectsService } from "./notification-read-subjects.service";
import { NotificationPushService } from "./notification-push.service";
import { ApnsPushService } from "./apns-push.service";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationNudgesService } from "./notification-nudges.service";

describe("Notifications focused capability injection", () => {
  it("composes badge counts without injecting notification writers", async () => {
    const readState = {
      getUndeliveredCount: jest.fn().mockResolvedValue(4),
      getUnreadCommentCount: jest.fn().mockResolvedValue(2),
      getNavUnread: jest.fn().mockResolvedValue({ hasUnreadComments: true }),
      markReadByFilter: jest.fn(),
    };
    const subjects = { markReadBySubject: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        NotificationsController,
        { provide: NotificationQueryService, useValue: {} },
        { provide: NotificationReadStateService, useValue: readState },
        { provide: NotificationReadSubjectsService, useValue: subjects },
        { provide: NotificationPushService, useValue: {} },
        { provide: ApnsPushService, useValue: {} },
        { provide: NotificationPreferencesService, useValue: {} },
        { provide: NotificationNudgesService, useValue: {} },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    try {
      const controller = module.get(NotificationsController);
      expect(await controller.unreadCount("viewer")).toEqual({
        data: { count: 4, unreadCommentCount: 2, hasUnreadComments: true },
      });
      expect(readState.getUndeliveredCount).toHaveBeenCalledWith("viewer");
      await controller.markReadBySubject("viewer", { post_id: "post" });
      expect(subjects.markReadBySubject).toHaveBeenCalledWith("viewer", {
        postId: "post",
        userId: null,
        articleId: null,
        crewId: null,
        groupId: null,
        boardThreadId: null,
      });
      await controller.markReadBySubject("viewer", { filter: "board" });
      expect(readState.markReadByFilter).toHaveBeenCalledWith(
        "viewer",
        "board",
      );
      expect(subjects.markReadBySubject).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });
});
