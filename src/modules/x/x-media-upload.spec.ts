import { XApiClient } from "./x-api.client";
const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });
describe("local X provider fixtures: no real network", () => {
  afterEach(() => jest.restoreAllMocks());
  it("sends the documented poll, reply, quote and edit shapes", async () => {
    const fetch = jest
      .spyOn(global, "fetch")
      .mockImplementation(async () => response({ id: "123" }));
    const api = new XApiClient();
    await api.createPost("fixture", {
      text: "Poll",
      poll: { options: ["A", "B"], duration_minutes: 10 },
    });
    await api.createPost("fixture", { text: "Reply", replyToId: "99" });
    await api.createPost("fixture", { text: "Quote", quoteId: "99" });
    await api.createPost("fixture", { text: "Edited", previousId: "99" });
    expect(
      fetch.mock.calls.map((c) => JSON.parse(c[1]?.body as string)),
    ).toEqual([
      { text: "Poll", poll: { options: ["A", "B"], duration_minutes: 10 } },
      { text: "Reply", reply: { in_reply_to_tweet_id: "99" } },
      { text: "Quote", quote_tweet_id: "99" },
      { text: "Edited", edit_options: { previous_post_id: "99" } },
    ]);
  });
  it("chunks video, finalizes once and does not publish before processing succeeds", async () => {
    const paths: string[] = [];
    jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/initialize")) return response({ id: "777" });
      if (path.endsWith("/append")) return response({});
      if (path.endsWith("/finalize"))
        return response({ processing_info: { state: "succeeded" } });
      throw new Error("Unexpected fixture request");
    });
    const bytes = new Uint8Array(5 * 1024 * 1024 + 7);
    const guard = jest.fn(async () => undefined);
    expect(
      await new XApiClient().uploadMovingMedia(
        "fixture",
        new Response(bytes, {
          headers: {
            "content-type": "video/mp4",
            "content-length": String(bytes.length),
          },
        }),
        "tweet_video",
        guard,
      ),
    ).toBe("777");
    expect(paths.filter((p) => p.endsWith("/append"))).toHaveLength(2);
    expect(paths.filter((p) => p.endsWith("/finalize"))).toHaveLength(1);
    expect(guard).toHaveBeenCalledTimes(4);
  });
  it("aborts on a pause or length mismatch, without issuing a create", async () => {
    const fetch = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(response({ id: "777" }));
    const media = () =>
      new Response(new Uint8Array(2), {
        headers: { "content-type": "image/gif", "content-length": "3" },
      });
    await expect(
      new XApiClient().uploadMovingMedia(
        "fixture",
        media(),
        "tweet_gif",
        async () => {
          throw new Error("paused");
        },
      ),
    ).rejects.toThrow("paused");
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      new XApiClient().uploadMovingMedia(
        "fixture",
        media(),
        "tweet_gif",
        async () => undefined,
      ),
    ).rejects.toThrow("incomplete");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
