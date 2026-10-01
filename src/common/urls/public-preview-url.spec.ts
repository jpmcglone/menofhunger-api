import { publicPreviewUrl } from "./public-preview-url";
describe("public profile website and preview inputs", () => {
  it.each([
    "http://127.0.0.1/a",
    "http://[::1]/a",
    "http://0x7f000001/a",
    "http://localhost/a",
    "https://app.internal/a",
    "https://name:secret@example.com/",
    "https://rumble.com/-livestream-api/get-data?key=private",
    "javascript:alert(1)",
  ])("rejects %s", (url) => {
    expect(publicPreviewUrl(url)).toBeNull();
  });
  it("preserves normal public profiles and website query parameters", () => {
    expect(publicPreviewUrl("https://rumble.com/c/channel")).toBe(
      "https://rumble.com/c/channel",
    );
    expect(publicPreviewUrl("https://example.com/?page=about#bio")).toBe(
      "https://example.com/?page=about",
    );
  });
});
