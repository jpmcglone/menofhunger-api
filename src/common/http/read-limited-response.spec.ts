import { readLimitedResponse } from "./read-limited-response";
describe("bounded external responses", () => {
  it("rejects a large stream even when Content-Length is absent", async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    });
    await expect(readLimitedResponse(new Response(stream), 10)).rejects.toThrow(
      "too large",
    );
    expect(cancel).toHaveBeenCalled();
  });
  it("returns complete small bodies", async () => {
    expect(
      (await readLimitedResponse(new Response("hello"), 10)).toString(),
    ).toBe("hello");
  });
});
