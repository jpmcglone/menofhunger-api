import { Injectable } from '@nestjs/common';
import { parseMentionsFromBody } from '../../../common/mentions/mention-regex';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';

/**
 * Detects @marv mentions in post/message bodies.
 *
 * We re-use the existing email-safe `parseMentionsFromBody` regex (`@username` not
 * preceded by a word char) so behavior matches the rest of the app exactly. We then
 * compare the parsed usernames against the configured Marv username (case-insensitive).
 *
 * IMPORTANT: this is a lightweight text check, not a database lookup. Resolving the
 * username to a User row is the caller's job (PostsService already does that).
 */
@Injectable()
export class MarvinMentionDetectorService {
  constructor(private readonly identity: MarvinBotIdentityService) {}

  /**
   * Returns true when the given body text contains an `@marv` mention (case-insensitive).
   * Email-like prefixes (foo@bar) are skipped per the shared mention regex.
   */
  bodyMentionsMarv(body: string | null | undefined): boolean {
    if (!body) return false;
    const usernames = parseMentionsFromBody(body);
    if (usernames.length === 0) return false;
    const marvLower = this.identity.marvUsernameLower();
    return usernames.some((u) => u.toLowerCase() === marvLower);
  }

  /**
   * Variant used inside `runPostCreateSideEffects` where we already have resolved user ids.
   * Cheaper than re-parsing the body.
   */
  resolvedIdsIncludeMarv(resolvedUserIds: Iterable<string>): boolean {
    const marvId = this.identity.cachedMarvUserId();
    if (!marvId) return false;
    for (const id of resolvedUserIds) {
      if (id === marvId) return true;
    }
    return false;
  }
}
