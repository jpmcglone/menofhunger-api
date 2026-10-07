import { LinkMetadataService } from "./link-metadata.service";
import { fetchPickaxProfile } from "./pickax-profile-metadata";
import { PostsReadService } from '../posts-read/posts-read.service';
jest.mock("./pickax-profile-metadata", () => ({
  ...jest.requireActual("./pickax-profile-metadata"),
  fetchPickaxProfile: jest.fn(),
}));
describe("durable Pickax preview cache", () => {
  it("reuses the public snapshot after a front-cache loss without fetching again", async () => {
    const meta = {
      url: "https://pickax.com/john",
      title: "John",
      description: null,
      imageUrl: null,
      siteName: "Pickax",
      socialPost: null,
      videoEmbed: null,
      profile: {
        platform: "pickax",
        username: "john",
        avatarUrl: null,
        followers: 0,
        following: 0,
      },
    };
    let saved: unknown = null;
    const prisma = {
      integrationPublicSnapshot: {
        findUnique: jest.fn(async () => saved),
        upsert: jest.fn(async ({ create }) => {
          saved = create;
          return create;
        }),
      },
    };
    const cache = {
      getOrSetJsonWithLock: jest.fn(async ({ computeAndSet }) =>
        computeAndSet(),
      ),
    };
    const service = new LinkMetadataService(prisma as never,
      cache as never,
      {} as never, new PostsReadService(prisma as never as never));
    jest.mocked(fetchPickaxProfile).mockResolvedValue(meta as never);
    expect(await service.getMetadata(meta.url, true)).toEqual(meta);
    expect(await service.getMetadata(meta.url, true)).toEqual(meta);
    expect(fetchPickaxProfile).toHaveBeenCalledTimes(1);
    expect(prisma.integrationPublicSnapshot.upsert).toHaveBeenCalledTimes(1);
  });
});
