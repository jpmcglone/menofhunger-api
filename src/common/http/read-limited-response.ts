/** Bound streamed responses as well as Content-Length; cancel before accumulating excess. */
export async function readLimitedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Response is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("Response is too large.");
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}
