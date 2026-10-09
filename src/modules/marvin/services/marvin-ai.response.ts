

/** Pull the assistant's plain-text content out of a Responses API result. */
export function extractText(result: any): string {
  const output = Array.isArray(result?.output) ? result.output : [];
  let text = '';
  for (const item of output) {
    if (!item) continue;
    if (item.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const part of parts) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
        }
      }
    }
  }
  if (!text && typeof result?.output_text === 'string') text = result.output_text;
  return text.trim();
}

/** Find any unanswered function tool calls in a Responses API result. */
export function extractFunctionCalls(result: any): Array<{ call_id: string; name: string; arguments: string }> {
  const output = Array.isArray(result?.output) ? result.output : [];
  const calls: Array<{ call_id: string; name: string; arguments: string }> = [];
  for (const item of output) {
    if (!item) continue;
    const callId = item.call_id ?? item.id;
    if (item.type === 'function_call' && callId && item.name) {
      calls.push({
        call_id: String(callId),
        name: String(item.name),
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
    }
  }
  return calls;
}

/** Public image URLs from get_post / list_public_posts tool JSON. */
export function extractToolImageUrls(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as {
      imageUrls?: unknown;
      posts?: Array<{ imageUrls?: unknown }>;
    };
    const raw: unknown[] = [];
    if (Array.isArray(parsed.imageUrls)) raw.push(...parsed.imageUrls);
    for (const post of parsed.posts ?? []) {
      if (Array.isArray(post?.imageUrls)) raw.push(...post.imageUrls);
    }
    return raw.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  } catch {
    return [];
  }
}
