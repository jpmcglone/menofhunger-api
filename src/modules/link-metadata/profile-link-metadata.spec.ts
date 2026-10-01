import { profileLinkMetadata } from "./profile-link-metadata";
const meta = {
  url: "https://pickax.com/member",
  title: "Member",
  description: "Public profile",
  imageUrl: null,
  siteName: "Pickax",
  videoEmbed: null,
  socialPost: null,
};
describe("public profile metadata fallback", () => {
  it.each(["Login | Pickax", "Sign in | LinkedIn", "Just a moment…"])(
    "does not present %s as a profile",
    (title) => {
      expect(profileLinkMetadata({ ...meta, title })).toBeNull();
    },
  );
  it("keeps public metadata but omits an unsafe image", () => {
    expect(
      profileLinkMetadata({ ...meta, imageUrl: "http://127.0.0.1/private" }),
    ).toEqual(meta);
  });
});
