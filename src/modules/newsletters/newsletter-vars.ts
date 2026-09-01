import { firstNameFrom, preferredDisplayName } from '../email/email-send.helpers';

export type NewsletterVars = {
  firstName: string;
  name: string;
  username: string;
};

const KNOWN_TOKEN = /\{\{\s*(firstName|name|username)\s*\}\}/g;

export function varsForUser(user: {
  name?: string | null;
  username?: string | null;
}): NewsletterVars {
  const username = String(user.username ?? '').trim();
  return {
    firstName: firstNameFrom({ name: user.name, username: user.username }),
    name: preferredDisplayName({ name: user.name, username: user.username }) ?? username,
    username,
  };
}

export function interpolateTemplate(input: string, vars: NewsletterVars): string {
  return String(input ?? '').replace(KNOWN_TOKEN, (_match, key: keyof NewsletterVars) => vars[key] ?? '');
}

export function interpolateTiptapJson(json: string, vars: NewsletterVars): string {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return json;
  }
  walkNode(doc, vars);
  return JSON.stringify(doc);
}

function walkNode(node: unknown, vars: NewsletterVars): void {
  if (!node || typeof node !== 'object') return;
  const rec = node as { text?: unknown; content?: unknown };
  if (typeof rec.text === 'string') rec.text = interpolateTemplate(rec.text, vars);
  if (Array.isArray(rec.content)) {
    for (const child of rec.content) walkNode(child, vars);
  }
}
