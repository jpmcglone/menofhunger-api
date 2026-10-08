/** Normalize a tag to a stable slug key (lowercase, alphanumeric + hyphens, max 50 chars). */
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

/**
 * Strip leading/trailing whitespace from every line, trim the whole string,
 * and collapse runs of 2+ blank lines into a single blank line.
 */
export function normalizeCommentBody(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
    .replace(/\n{3,}/g, '\n\n');
}
