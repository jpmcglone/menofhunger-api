import { XPublicSnapshotService } from "./x-public-snapshot.service";
const profile = (now = Date.now()) => ({
  id: "123",
  username: "hunter",
  name: "Hunter",
  description: null,
  avatarUrl: null,
  bannerUrl: null,
  websiteUrl: null,
  verified: false,
  followers: 10,
  following: 20,
  fetchedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 86400000).toISOString(),
});
function harness(payload: unknown) {
  const db = {
    integrationPublicSnapshot: {
      findFirst: jest.fn(async () => ({ payload, identity: "123" })),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  return { db, service: new XPublicSnapshotService(db as any) };
}
describe("durable public X snapshots", () => {
  it("recovers a fresh normalized public snapshot by immutable identity and checks the current handle", async () => {
    const value = profile(),
      { service } = harness(value);
    expect(await service.profile("123", "hunter")).toEqual(value);
    expect(await service.profile("123", "renamed")).toBeNull();
    expect(await service.profile("456", "hunter")).toBeNull();
  });
  it("rejects expired, excessively retained and viewer-specific data", async () => {
    for (const value of [
      { ...profile(), expiresAt: "2000-01-01T00:00:00.000Z" },
      {
        ...profile(),
        expiresAt: new Date(Date.now() + 172800000).toISOString(),
      },
      { ...profile(), messageUrl: "private" },
    ]) {
      expect(await harness(value).service.profile("123", "hunter")).toBeNull();
    }
  });
  it("refuses private context and unsafe image URLs before persistence", async () => {
    const h = harness(null);
    await expect(
      h.service.saveProfile({ ...profile(), followingYou: true } as any),
    ).rejects.toThrow();
    await expect(
      h.service.saveProfile({
        ...profile(),
        avatarUrl: "http://localhost/image",
      }),
    ).rejects.toThrow();
    expect(h.db.integrationPublicSnapshot.upsert).not.toHaveBeenCalled();
  });
});
