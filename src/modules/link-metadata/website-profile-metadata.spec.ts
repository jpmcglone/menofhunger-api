import { parseWebsiteMetadata, publicAddress } from "./website-profile-metadata";
describe("website social metadata", () => {
  it("prefers declared social metadata over document text and decodes entities", () => {
    expect(parseWebsiteMetadata(`<head><title>Generic</title><meta content="Title &amp; work" property="og:title"><meta name='description' content='Fallback'><meta property='og:description' content='A public description'><meta property="og:image" content="/social.png"><script>"<meta property='og:title' content='wrong'>"</script></head>`, "https://example.com/me")).toMatchObject({ title: "Title & work", description: "A public description", imageUrl: "https://example.com/social.png" });
  });
  it("keeps partial metadata without inventing a description", () => {
    expect(parseWebsiteMetadata('<title>John</title>', 'https://example.com')).toMatchObject({ title: 'John', description: null, imageUrl: null });
    expect(parseWebsiteMetadata('<html></html>', 'https://example.com')).toBeNull();
  });
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1'])("blocks non-public DNS destination %s", address => expect(publicAddress(address)).toBe(false));
  it("permits public addresses", () => expect(publicAddress('93.184.216.34')).toBe(true));
});
