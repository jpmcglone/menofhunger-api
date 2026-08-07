import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Source-scanning guardrails for the side-effects seam.
 *
 * The architecture only holds if the *easy* thing stays the *right* thing. These tests fail the
 * build when someone reaches past the seam — writing a notification inline on a request path, or
 * reaching for `setImmediate` to "defer" work that a deploy would then silently drop.
 *
 * Same idea as the www repo's `tests/hydration-guardrails.test.ts`: cheap regex over source, no
 * TypeScript program needed.
 */

const MODULES_DIR = join(__dirname, '..');
const SRC_DIR = join(MODULES_DIR, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALL_TS_FILES = walk(SRC_DIR);

function rel(file: string): string {
  return relative(SRC_DIR, file).split(sep).join('/');
}

// ─── setImmediate ────────────────────────────────────────────────────────────

describe('setImmediate is confined to the side-effects fallback', () => {
  it('does not appear in production code outside src/modules/side-effects', () => {
    const offenders = ALL_TS_FILES.filter((file) => {
      const path = rel(file);
      // Specs use it as a microtask-flush helper, which is not deferred production work.
      if (path.endsWith('.spec.ts')) return false;
      if (path.startsWith('modules/side-effects/')) return false;
      return /\bsetImmediate\s*\(/.test(readFileSync(file, 'utf8'));
    });

    expect(offenders.map(rel)).toEqual([]);
  });
});

// ─── NotificationsService / NotificationPushService reach-through ────────────

/**
 * File-suffix patterns that are *already* off the request path, so writing notifications
 * directly from them is correct rather than a leak.
 */
const OFF_REQUEST_PATH_SUFFIXES = [
  '-side-effects.handler.ts',
  '-events.handler.ts',
  '.cron.ts',
  '.processor.ts',
  '.module.ts',
  '.spec.ts',
];

/**
 * Request-path files allowed to touch notifications directly, each for a stated reason.
 *
 * Adding an entry here is a deliberate architectural exception — write down *why* the work
 * cannot move to the queue, or move it to the queue instead.
 */
const ALLOWED_DIRECT_NOTIFICATION_USERS: Record<string, string> = {
  // Reads back the notification row it just wrote to compute the nudge cooldown, so the row
  // IS the feature's state. Only the push is dispatched.
  'modules/follows/follows.service.ts': 'nudge cooldown is read-after-write on the row itself',
  // Clears the *viewer's own* unread state as they open a post/article. The user expects the
  // badge to drop on this request; there is nothing to send and nobody else to notify.
  'modules/post-views/post-views.service.ts': 'marks the viewer\u2019s own notifications read',
  'modules/article-views/article-views.service.ts': 'marks the viewer\u2019s own notifications read',
  // Read-only badge counts assembled for the /auth/me payload.
  'modules/auth/auth.controller.ts': 'reads undelivered counts for the session payload',
  // The notifications module's own HTTP surface (read + read-state endpoints).
  'modules/notifications/notifications.controller.ts': 'the notifications read/read-state API',
  // Admin-only test-push tool: sends directly to the requesting admin's own devices, no
  // side-effect fan-out needed. This is diagnostic tooling, not a user-facing mutation.
  'modules/admin/admin-push.controller.ts': 'admin tool that fires a test push to the admin\'s own devices',
};

describe('notification writes go through the side-effects seam', () => {
  it('is not imported by request-path services outside the notifications module', () => {
    const offenders = ALL_TS_FILES.filter((file) => {
      const path = rel(file);
      if (path.startsWith('modules/notifications/')) {
        // The module owns these classes; only its controller is externally reachable, and it
        // is allowlisted above.
        return false;
      }
      if (OFF_REQUEST_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix))) return false;
      if (path in ALLOWED_DIRECT_NOTIFICATION_USERS) return false;

      const src = readFileSync(file, 'utf8');
      return /from '.*notifications\.service'|from '.*notification-push\.service'/.test(src);
    });

    expect(offenders.map(rel)).toEqual([]);
  });

  it('keeps the allowlist honest — every entry still imports notifications', () => {
    const stale = Object.keys(ALLOWED_DIRECT_NOTIFICATION_USERS).filter((path) => {
      const src = readFileSync(join(SRC_DIR, path), 'utf8');
      return !/from '.*notifications\.service'|from '.*notification-push\.service'/.test(src);
    });

    expect(stale).toEqual([]);
  });
});

// ─── Every declared side effect has a handler ────────────────────────────────

describe('side-effect names and handlers stay in sync', () => {
  function declaredNames(): string[] {
    const src = readFileSync(join(__dirname, 'side-effects.constants.ts'), 'utf8');
    const body = src.slice(src.indexOf('export interface SideEffectPayloads'));
    return [...body.matchAll(/^ {2}'([a-z0-9.\-]+)':/gm)].map((m) => m[1]);
  }

  function registeredNames(): string[] {
    const names = new Set<string>();
    for (const file of ALL_TS_FILES) {
      if (rel(file).endsWith('.spec.ts')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/registry\.register\(\s*'([a-z0-9.\-]+)'/g)) names.add(m[1]);
    }
    return [...names];
  }

  it('registers a handler for every declared payload', () => {
    const registered = new Set(registeredNames());
    // A dispatch with no handler is the worst failure mode here: it enqueues, the processor
    // finds nothing, and the work silently never happens.
    const unhandled = declaredNames().filter((name) => !registered.has(name));

    expect(unhandled).toEqual([]);
  });

  it('does not register a handler for an undeclared name', () => {
    const declared = new Set(declaredNames());
    const undeclared = registeredNames().filter((name) => !declared.has(name));

    expect(undeclared).toEqual([]);
  });
});
