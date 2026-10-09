import { type MarvThreadContext, type MarvThreadContextPost } from "./marvin-thread-context.service";
import { marvMediaMarker } from "./marvin-vision-media";
import {
  MARV_CONCISENESS,
  renderGroupContextLines,
  renderMemberBackgroundLines,
} from "../marvin-prompt-instructions";

export function buildCatchUpPrompt(
  context: MarvThreadContext,
  opts: {
    imageCount: number;
    hasGifAttached: boolean;
    rollingSummary?: string;
    linkPreviews?: Array<{
      url: string;
      title: string | null;
      description: string | null;
      siteName: string | null;
      imageUrl?: string | null;
    }>;
    /** Present when the viewer has summarized this thread before — drives the SINCE section. */
    delta?: { previousSummary: string; sinceMs: number; newReplyCount: number };
    /** Public profiles for people who appear in the window — background, not thread content. */
    memberCards?: Array<{ username: string; cardText: string | null }>;
    /** Community group this thread lives in. */
    group?: {
      name: string;
      description: string | null;
      rules?: string | null;
      joinPolicy?: "open" | "approval" | null;
      memberCount?: number | null;
    };
  },
): { developerNote: string; userMessage: string } {
  const {
    imageCount,
    hasGifAttached,
    rollingSummary,
    linkPreviews,
    delta,
    memberCards,
    group,
  } = opts;
  const hasImages = imageCount > 0;
  const hasThread =
    context.ancestors.length > 0 || context.descendants.length > 0;
  const hasReplies = context.descendants.length > 0;
  const lines: string[] = [];

  // Core task + grounding
  lines.push(
    (hasThread
      ? "TASK: Summarize what this conversation is ABOUT and where it landed — the throughline, " +
        "the main points, any disagreement or conclusion — anchored on the highlighted post. " +
        'SYNTHESIZE; do NOT narrate it post-by-post ("@a said X, then @b said Y"). ' +
        "Name people only when who-holds-which-position actually matters, not as a transcript. "
      : "TASK: Summarize the point of the highlighted post in one sentence. ") +
      "Stay in your voice — brief and stoic, plain prose, no preamble. " +
      "Length scales with substance: a thin or trivial post gets ONE sentence; only a genuinely " +
      "busy thread earns a short paragraph. " +
      "You may use web search or general knowledge for a quick factual gloss on a referenced " +
      "event, person, or term — one clause, not a lecture. Any such gloss must read as background " +
      "context, never as something said in the thread. " +
      'Do NOT speculate about messages that might be posted later or about what you would "need." ' +
      "Stay neutral; no opinions or advice. " +
      'Never say "nothing to summarize." ' +
      (group
        ? "The group name and info below are the venue — use them as background, not as thread content. "
        : "") +
      (hasImages
        ? ` The ${imageCount > 1 ? `${imageCount} attached images are` : "attached image is"} part of the ` +
          "conversation — describe what they actually show (scene, subject, any text in the image) as part " +
          "of the summary; for a near-empty caption the image is the substance. Images are given in reading " +
          "order, matching the posts marked [attached: …]."
        : "") +
      (hasGifAttached
        ? " One attached image is an animated GIF; treat it as a moving reaction, not a still."
        : ""),
  );

  // Anti-fabrication guardrail
  lines.push("");
  lines.push(
    "GROUNDING: Summarize ONLY what is actually written in this thread. " +
      "Never invent names, quotes, numbers, claims, or details not present in the posts below. " +
      "If something is unclear or ambiguous, omit it rather than guess. " +
      "Member background below is public profile context, not thread content — use it only to understand who is speaking.",
  );

  if (group) {
    lines.push("");
    lines.push(...renderGroupContextLines(group));
  }

  const background = renderMemberBackgroundLines(memberCards ?? []);
  if (background.length > 0) {
    lines.push("");
    lines.push(...background);
  }

  // Sections format (only when there are replies)
  if (hasReplies) {
    lines.push("");
    const postLine =
      "POST: [the highlighted post's point, read IN CONTEXT of the path above it. " +
      "If it is a reply, make clear what it is responding to. One or two sentences.]";
    const repliesLine =
      "REPLIES: [synthesis of the replies BELOW the highlighted post — throughline, key points, any conclusion]";
    if (delta) {
      lines.push(
        "FORMAT: Output EXACTLY three labeled paragraphs with no other text:\n" +
          `SINCE: [what has changed since the earlier summary quoted below — the reader has ` +
          `ALREADY read that summary, so cover only the ${delta.newReplyCount} newer ` +
          `repl${delta.newReplyCount === 1 ? "y" : "ies"} marked [new] and any shift in where ` +
          `the thread landed. Do NOT repeat what the earlier summary already said. If the new ` +
          `replies add nothing of substance, say so in one short sentence.]\n` +
          `${postLine}\n${repliesLine}`,
      );
    } else {
      lines.push(
        `FORMAT: Output EXACTLY two labeled paragraphs with no other text:\n${postLine}\n${repliesLine}`,
      );
    }
  }

  // Prior summary the reader has already seen — the baseline the SINCE section works against.
  if (delta) {
    lines.push("");
    lines.push("Earlier summary the reader has already read:");
    lines.push(`  ${delta.previousSummary.trim().slice(0, 1500)}`);
  }

  // Rolling summary covers posts beyond the context window (mirrors prompt-builder line 176-179).
  if (rollingSummary?.trim()) {
    lines.push("");
    lines.push("Thread summary so far (older posts beyond the window below):");
    lines.push(`  ${rollingSummary.trim().slice(0, 1500)}`);
  }

  if (context.ancestors.length > 0) {
    lines.push("");
    lines.push("Path above the highlighted post (oldest → newest):");
    for (const p of context.ancestors) lines.push(`  ${renderCatchUpPost(p)}`);
  }

  if (context.focal) {
    lines.push("");
    lines.push(`Highlighted post: ${renderCatchUpPost(context.focal)}`);
  }

  if (context.descendants.length > 0) {
    lines.push("");
    lines.push(
      delta
        ? "Replies below the highlighted post (depth-first reading order); [new] marks replies posted after the earlier summary:"
        : "Replies below the highlighted post (depth-first reading order):",
    );
    for (const p of context.descendants) {
      const indent = "  ".repeat(Math.max(1, p.depth));
      const isNew = delta
        ? Math.max(p.createdAt.getTime(), p.editedAt?.getTime() ?? 0) >
          delta.sinceMs
        : false;
      lines.push(`${indent}${isNew ? "[new] " : ""}${renderCatchUpPost(p)}`);
    }
    const hidden = context.totalDescendants - context.descendants.length;
    if (hidden > 0)
      lines.push(
        `  …and ${hidden} more repl${hidden === 1 ? "y" : "ies"} not shown.`,
      );
  }

  if (linkPreviews && linkPreviews.length > 0) {
    lines.push("");
    lines.push("[Link previews from the conversation]");
    for (const lp of linkPreviews) {
      const site = lp.siteName ? ` — ${lp.siteName}` : "";
      const desc = lp.description ? ` — ${lp.description.slice(0, 120)}` : "";
      const img = lp.imageUrl ? " [preview image attached]" : "";
      const title = lp.title ?? lp.url;
      lines.push(`  - "${title}"${site}${desc}${img}`);
    }
  }

  lines.push("");
  lines.push(MARV_CONCISENESS);

  return {
    developerNote: lines.join("\n"),
    userMessage: "Catch me up on this post and any conversation around it.",
  };
}

export function renderCatchUpPost(p: MarvThreadContextPost): string {
  const handle = p.isMarv ? '@marv' : p.authorUsername ? `@${p.authorUsername}` : (p.authorDisplayName ?? 'someone');
  const checkin = p.checkinPrompt ? `[check-in: "${p.checkinPrompt.slice(0, 120)}"] ` : '';
  const poll = p.poll ? ` [poll: ${p.poll.options.map((o) => `${o.text} (${o.voteCount})`).join(', ')}]` : '';
  return `${handle}: ${checkin}"${p.body}"${marvMediaMarker(p.media)}${poll}`;
}
