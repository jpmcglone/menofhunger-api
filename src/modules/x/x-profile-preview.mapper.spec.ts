import { mapXProfile, publicXUrl } from "./x-profile-preview.mapper";
const profile = {
  id: "123",
  username: "example",
  name: "Example",
  protected: false,
};
describe("X public preview isolation", () => {
  it("omits private viewer fields and retains absent counts as unknown", () => {
    const result = mapXProfile(
      { ...profile, receives_your_dm: true, connection_status: ["following"] },
      "123",
    );
    expect(result).toMatchObject({
      id: "123",
      followers: null,
      following: null,
    });
    expect(result).not.toHaveProperty("receives_your_dm");
    expect(result).not.toHaveProperty("connection_status");
  });
  it("rejects protected accounts, mismatched identity and malformed fields", () => {
    expect(mapXProfile({ ...profile, protected: true }, "123")).toBeNull();
    expect(mapXProfile(profile, "456")).toBeNull();
    expect(mapXProfile({ ...profile, protected: undefined }, "123")).toBeNull();
  });
  it("limits display lifetime to 24 hours", () => {
    expect(
      mapXProfile(profile, "123", new Date("2026-10-01T12:00:00Z"))?.expiresAt,
    ).toBe("2026-10-02T12:00:00.000Z");
  });
  it("accepts only X-hosted HTTPS images and safe website links", () => {
    expect(publicXUrl("https://pbs.twimg.com/banner.jpg", true)).toBe(
      "https://pbs.twimg.com/banner.jpg",
    );
    expect(publicXUrl("https://evil.test/banner.jpg", true)).toBeNull();
    expect(publicXUrl("javascript:alert(1)")).toBeNull();
    expect(publicXUrl("https://secret@example.com")).toBeNull();
  });
});
