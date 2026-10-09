import "reflect-metadata";
import {
  ForbiddenException,
  type INestApplication,
  RequestMethod,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  MODULE_METADATA,
} from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AuthService } from "../auth/auth.service";
import { AuthGuard, OptionalAuthGuard } from "../auth/auth-public-api";
import { PostsEngagementService } from "./posts-engagement.service";
import { PostsController } from "./posts.controller";
import { PostsProfileController } from "./posts-profile.controller";
import { PostsThreadController } from "./posts-thread.controller";
import { PostsRelatedController } from "./posts-related.controller";
import { PostsPublicationController } from "./posts-publication.controller";
import { PostsEngagementController } from "./posts-engagement.controller";
import { PostsPollController } from "./posts-poll.controller";
import { PostsModule } from "./posts.module";

const routeContract = [
  [PostsController, "list", RequestMethod.GET, "/", false],
  [PostsController, "getById", RequestMethod.GET, ":id", false],
  [
    PostsProfileController,
    "listForUser",
    RequestMethod.GET,
    "user/:username",
    false,
  ],
  [
    PostsProfileController,
    "listUserMedia",
    RequestMethod.GET,
    "user/:username/media",
    false,
  ],
  [PostsProfileController, "listOnlyMe", RequestMethod.GET, "me/only-me", true],
  [
    PostsThreadController,
    "listComments",
    RequestMethod.GET,
    ":id/comments",
    false,
  ],
  [
    PostsThreadController,
    "getThreadParticipants",
    RequestMethod.GET,
    ":id/thread-participants",
    false,
  ],
  [
    PostsRelatedController,
    "listReposters",
    RequestMethod.GET,
    ":id/reposts",
    false,
  ],
  [
    PostsRelatedController,
    "listQuotes",
    RequestMethod.GET,
    ":id/quotes",
    false,
  ],
  [
    PostsRelatedController,
    "listDiscoverMore",
    RequestMethod.GET,
    ":id/discover-more",
    false,
  ],
  [PostsPublicationController, "create", RequestMethod.POST, "/", true],
  [PostsPublicationController, "update", RequestMethod.PATCH, ":id", true],
  [PostsPublicationController, "delete", RequestMethod.DELETE, ":id", true],
  [
    PostsPublicationController,
    "publishFromOnlyMe",
    RequestMethod.POST,
    ":id/publish-from-only-me",
    true,
  ],
  [PostsEngagementController, "boost", RequestMethod.POST, ":id/boost", true],
  [
    PostsEngagementController,
    "unboost",
    RequestMethod.DELETE,
    ":id/boost",
    true,
  ],
  [PostsEngagementController, "repost", RequestMethod.POST, ":id/repost", true],
  [
    PostsEngagementController,
    "unrepost",
    RequestMethod.DELETE,
    ":id/repost",
    true,
  ],
  [
    PostsPollController,
    "voteOnPoll",
    RequestMethod.POST,
    ":id/poll/vote",
    true,
  ],
  [PostsPollController, "skipPoll", RequestMethod.POST, ":id/poll/skip", true],
] as const;

describe("public post route compatibility across controller boundaries", () => {
  it.each(routeContract)(
    "%s.%s retains its HTTP path, verb and access guard",
    (controller, method, verb, path, authenticated) => {
      const handler = (
        controller.prototype as unknown as Record<string, object>
      )[method];
      expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe("posts");
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
        authenticated ? AuthGuard : OptionalAuthGuard,
      );
      const registered: unknown[] = Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        PostsModule,
      );
      expect(registered).toContain(controller);
    },
  );

  it("keeps publication transaction and authorization collaborators private to the module", () => {
    const exported: Array<{ name: string }> = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      PostsModule,
    );
    const internal = [
      "PostsWriteAuthorizationService",
      "PostsWritePersistenceService",
      "PostsCheckinWriteService",
      "PostsQuoteWriteService",
      "PostsBoardWritePolicy",
    ];
    expect(
      exported
        .map((provider) => provider.name)
        .filter((name) => internal.includes(name)),
    ).toEqual([]);
  });

  it("registers static feed routes before the generic post permalink", () => {
    const registered: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      PostsModule,
    );
    expect(registered.indexOf(PostsProfileController)).toBeLessThan(
      registered.indexOf(PostsController),
    );
  });
});

describe("post engagement HTTP boundary with one domain dependency", () => {
  let app: INestApplication;
  const engagement = { boostPost: jest.fn(async () => ({ success: true })) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PostsEngagementController],
      providers: [
        { provide: PostsEngagementService, useValue: engagement },
        {
          provide: AuthService,
          useValue: {
            meFromSessionToken: async (token?: string) =>
              token === "valid"
                ? { user: { id: "actor" }, renewed: false }
                : null,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    await app.listen(0, "127.0.0.1");
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("rejects unauthenticated writes before invoking the command", async () => {
    await request(app.getHttpServer()).post("/posts/post-1/boost").expect(401);
    expect(engagement.boostPost).not.toHaveBeenCalled();
  });

  it("passes authenticated identity and preserves the response envelope", async () => {
    const result = await request(app.getHttpServer())
      .post("/posts/post-1/boost")
      .set("Cookie", "moh_session=valid")
      .send({ userId: "spoofed" })
      .expect(201);
    expect(engagement.boostPost).toHaveBeenCalledWith({
      userId: "actor",
      postId: "post-1",
    });
    expect(result.body).toEqual({ data: { success: true } });
  });

  it("propagates domain permission denial without a success envelope", async () => {
    engagement.boostPost.mockRejectedValueOnce(
      new ForbiddenException("Restricted post."),
    );
    const result = await request(app.getHttpServer())
      .post("/posts/post-1/boost")
      .set("Cookie", "moh_session=valid")
      .expect(403);
    expect(result.body).not.toHaveProperty("data");
  });
});
