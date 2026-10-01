import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePickaxProfile, pickaxProfileHandle } from "./pickax-profile-metadata";
const html = readFileSync(join(__dirname, "fixtures/pickax-profile.html"), "utf8");
describe("Pickax public profile", () => {
  it("reads the requested profile's avatar separately from its banner, with bio and counts", () => {
    const result = parsePickaxProfile(html, "themcglonecode");
    expect(result?.title).toBe("John McGlone");
    expect(result?.description).toBe("Public bio & links");
    expect(result?.profile).toMatchObject({ username: "TheMcGloneCode", followers: 111, following: 22 });
    expect(result?.profile.avatarUrl).toContain("https://img.pickax.com/user-8453/1790698968246-");
    expect(result?.imageUrl).toContain("https://img.pickax.com/user-8453/5be99437-");
    expect(result?.imageUrl).not.toBe(result?.profile.avatarUrl);
  });
  it("rejects another identity, invalid payloads and off-provider assets", () => {
    expect(parsePickaxProfile(html, "someoneelse")).toBeNull();
    expect(parsePickaxProfile('<script id="__NUXT_DATA__">not json</script>', "themcglonecode")).toBeNull();
    const unsafe = html.replace(/user-8453\/1790698968246-[^"]+/, "https://media.menofhunger.com/owned.jpg");
    expect(parsePickaxProfile(unsafe, "themcglonecode")?.profile.avatarUrl).toBeNull();
  });
  it.each(["https://pickax.com/post/123", "https://pickax.com.evil.test/john", "https://pickax.com/john?token=secret", "http://pickax.com/john"])("does not treat %s as a public profile", url => expect(pickaxProfileHandle(url)).toBeNull());
});
