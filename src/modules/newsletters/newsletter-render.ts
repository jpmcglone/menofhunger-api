import { siteOriginFromUrl } from "../email/email-rich-text";
import {
  EMAIL,
  EMAIL_CLASS,
  emailFooterLink,
  escapeHtml,
  renderButton,
  renderMohEmail,
} from "../email/templates/moh-email";
import { renderTiptapEmailHtml } from "../email/email-content-article";
import {
  interpolateTemplate,
  interpolateTiptapJson,
  type NewsletterVars,
} from "./newsletter-vars";

export type NewsletterRenderInput = {
  subject: string;
  preheader: string;
  bodyJson: string;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  heroImageUrl?: string | null;
  vars: NewsletterVars;
  unsubscribeUrl: string;
  settingsUrl: string;
  postalAddress: string;
  siteUrl?: string;
};

export type NewsletterRendered = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
};

export function renderNewsletterEmail(
  input: NewsletterRenderInput,
): NewsletterRendered {
  const subject =
    interpolateTemplate(input.subject, input.vars).trim() || "Men of Hunger";
  const interpolatedJson = interpolateTiptapJson(input.bodyJson, input.vars);
  const siteUrl =
    [input.siteUrl, input.settingsUrl]
      .map(siteOriginFromUrl)
      .find((origin) => /^https?:\/\//i.test(origin)) ||
    "https://menofhunger.com";
  const bodyHtml = renderTiptapEmailHtml(interpolatedJson, { siteUrl }) ?? "";
  const preheaderRaw = interpolateTemplate(input.preheader, input.vars).trim();
  const preheader = preheaderRaw || firstPlainLine(interpolatedJson) || subject;

  const headingHtml = `<div class="${EMAIL_CLASS.text}" style="font-size:26px;font-weight:800;letter-spacing:-0.02em;line-height:1.2;color:${EMAIL.text};margin:0 0 18px 0;">${escapeHtml(subject)}</div>`;

  const hero = (input.heroImageUrl ?? "").trim();
  const heroHtml = hero
    ? `<img src="${escapeHtml(hero)}" alt="" width="564" style="width:100%;max-width:100%;border-radius:10px;margin:0 0 20px 0;display:block;" />`
    : "";

  // Always offer a route into the community, even when an editor omits the optional CTA.
  // Preserve a complete custom CTA instead of adding a second competing button.
  const customLabel = (input.ctaLabel ?? "").trim();
  const customHref = safeCtaHref(input.ctaHref, siteUrl);
  const hasCustomCta = Boolean(customLabel && customHref);
  const ctaLabel = hasCustomCta ? customLabel : "Open Men of Hunger";
  const ctaHref = hasCustomCta ? customHref! : `${siteUrl}/home`;
  const ctaHtml = `<div style="margin-top:20px;">${renderButton({ href: ctaHref, label: ctaLabel, variant: "monochrome", size: "large" })}</div>`;

  const contentHtml = `${headingHtml}${heroHtml}${bodyHtml}${ctaHtml}`;
  const footerHtml = [
    `${emailFooterLink(siteUrl, "Visit Men of Hunger")}<br />`,
    `You're getting this because newsletters are on in Settings.`,
    `<a href="${escapeHtml(input.unsubscribeUrl)}" class="${EMAIL_CLASS.soft}" style="color:${EMAIL.soft};text-decoration:underline;">Unsubscribe from newsletters</a>`,
    ` · `,
    `<a href="${escapeHtml(input.settingsUrl)}" class="${EMAIL_CLASS.soft}" style="color:${EMAIL.soft};text-decoration:underline;">Manage notifications</a>`,
    `<br />${escapeHtml(input.postalAddress)}`,
  ].join(" ");

  const html = renderMohEmail({
    title: subject,
    preheader,
    contentHtml,
    footerHtml,
    brandHref: siteUrl,
  });

  const textParts = [
    firstPlainLine(interpolatedJson) ? tiptapToPlainText(interpolatedJson) : "",
    `${ctaLabel}: ${ctaHref}`,
    "",
    `You're getting this because newsletters are on in Settings.`,
    `Unsubscribe from newsletters: ${input.unsubscribeUrl}`,
    `Manage notifications: ${input.settingsUrl}`,
    input.postalAddress,
    `Visit Men of Hunger: ${siteUrl}`,
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === ""));

  return {
    subject,
    preheader,
    html,
    text: textParts.join("\n").trim() || subject,
  };
}

function safeCtaHref(
  href: string | null | undefined,
  siteUrl: string,
): string | null {
  const raw = (href ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, siteUrl);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function firstPlainLine(json: string): string {
  const text = tiptapToPlainText(json);
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  return line ?? "";
}

function tiptapToPlainText(json: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return "";
  }
  const lines: string[] = [];
  collectText(doc, lines);
  return lines.join("\n").trim();
}

function collectText(node: unknown, lines: string[]): void {
  if (!node || typeof node !== "object") return;
  const rec = node as { type?: string; text?: unknown; content?: unknown };
  if (typeof rec.text === "string" && rec.text.trim()) {
    const last = lines.length - 1;
    if (last >= 0 && rec.type === undefined) {
      lines[last] = `${lines[last] ?? ""}${rec.text}`;
    } else {
      lines.push(rec.text);
    }
  }
  if (Array.isArray(rec.content)) {
    const before = lines.length;
    for (const child of rec.content) collectText(child, lines);
    if (
      rec.type &&
      rec.type !== "text" &&
      rec.type !== "doc" &&
      rec.type !== "bulletList" &&
      rec.type !== "orderedList" &&
      rec.type !== "listItem" &&
      lines.length === before
    ) {
      // empty block
    }
    if (
      rec.type === "paragraph" ||
      rec.type === "heading" ||
      rec.type === "blockquote"
    ) {
      lines.push("");
    }
  }
}
