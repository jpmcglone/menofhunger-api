import { normalizeSocialProfileUrl } from "./social-profile-url";

describe("public social profile URLs", () => {
  it.each([
    [
      "rumble",
      "http://www.rumble.com/c/Example/",
      "https://rumble.com/c/Example",
    ],
    ["rumble", "rumble.com/user/Example", "https://rumble.com/user/Example"],
    [
      "linkedin",
      "https://www.linkedin.com/in/example",
      "https://linkedin.com/in/example",
    ],
    [
      "youtube",
      "https://www.youtube.com/@Example",
      "https://youtube.com/@Example",
    ],
  ] as const)(
    "canonicalizes %s without guessing the route",
    (provider, input, expected) => {
      expect(normalizeSocialProfileUrl(input, provider)).toBe(expected);
    },
  );
  it.each([
    "https://rumble.com/c/Example?key=secret",
    "https://rumble.com/c/Example#secret",
    "https://secret@rumble.com/c/Example",
    "https://rumble.com:8080/c/Example",
    "https://rumble.com.evil.test/c/Example",
    "https://rumble.com/-livestream-api/get-data?key=secret",
    "https://rumble.com/v123-example.html",
    "https://rumble.com/c/%2Fsecret",
  ])("rejects nonpublic-profile input %s", (input) => {
    expect(() => normalizeSocialProfileUrl(input, "rumble")).toThrow();
  });
  it("allows clearing a profile link", () =>
    expect(normalizeSocialProfileUrl(" ", "rumble")).toBeNull());
});
