import { XApiClient } from "./x-api.client";

describe("X final send boundary", () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    "https://example.com",
    "Look at example.com/path",
    "HTTPS://EXAMPLE.COM",
    "www.example.com",
    "例子.中国",
    "münchen.de",
  ])("never sends a URL: %s", async (text) => {
    const fetch = jest.spyOn(global, "fetch");
    await expect(
      new XApiClient().createPost("test-token", { text }),
    ).rejects.toMatchObject({ code: "links_unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("still sends plain text and photo IDs", async () => {
    const fetch = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "123" } }), { status: 201 }),
      );
    await expect(
      new XApiClient().createPost("test-token", {
        text: "Just words",
        mediaIds: ["photo"],
      }),
    ).resolves.toBe("123");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
      text: "Just words",
      media: { media_ids: ["photo"] },
    });
  });
});

describe("X viewer-specific profile permission", () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([undefined, false, "true", true])(
    "shows Message on X only for the boolean true: %s",
    async (permission) => {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              data: {
                id: "123",
                protected: false,
                receives_your_dm: permission,
                connection_status: ["followed_by"],
              },
            }),
          ),
        );
      const result = await new XApiClient().getProfileContext(
        "viewer-token",
        "123",
      );
      expect(result?.messageUrl).toBe(
        permission === true
          ? "https://x.com/messages/compose?recipient_id=123"
          : null,
      );
      expect(result?.followsYou).toBe(true);
    },
  );
  it("omits blocked, protected, withheld or mismatched identities", async () => {
    const fetch = jest.spyOn(global, "fetch");
    for (const override of [
      { protected: true },
      { withheld: { country_codes: ["US"] } },
      { id: "456" },
    ]) {
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "123",
              protected: false,
              receives_your_dm: true,
              ...override,
            },
          }),
        ),
      );
      expect(
        await new XApiClient().getProfileContext("viewer-token", "123"),
      ).toBeNull();
    }
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            id: "123",
            protected: false,
            receives_your_dm: true,
            connection_status: ["blocking"],
          },
        }),
      ),
    );
    expect(
      (await new XApiClient().getProfileContext("viewer-token", "123"))
        ?.messageUrl,
    ).toBeNull();
  });
});
