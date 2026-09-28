import { createHash } from 'node:crypto';

/** One durable reply per Board item, even across ambiguous delivery failures. */
export function boardMarvReplyId(parentId: string): string {
  return `c${createHash('sha256').update(`board-marv:${parentId}`).digest('hex').slice(0, 24)}`;
}
