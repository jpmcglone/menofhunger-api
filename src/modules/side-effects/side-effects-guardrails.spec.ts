import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

const MODULES_DIR = join(__dirname, "..");
const SRC_DIR = join(MODULES_DIR, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ALL_TS_FILES = walk(SRC_DIR);

function rel(file: string): string {
  return relative(SRC_DIR, file).split(sep).join("/");
}

// ─── setImmediate ────────────────────────────────────────────────────────────

describe("setImmediate is confined to the side-effects fallback", () => {
  it("does not appear in production code outside src/modules/side-effects", () => {
    const offenders = ALL_TS_FILES.filter((file) => {
      const path = rel(file);
      // Specs use it as a microtask-flush helper, which is not deferred production work.
      if (path.endsWith(".spec.ts")) return false;
      if (path.startsWith("modules/side-effects/")) return false;
      return /\bsetImmediate\s*\(/.test(readFileSync(file, "utf8"));
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
  "-side-effects.handler.ts",
  "-events.handler.ts",
  ".cron.ts",
  ".processor.ts",
  ".module.ts",
  ".spec.ts",
  ".testing.ts",
];

/** Private worker collaborators, invoked exclusively by PostsSideEffectsHandler. */
const WORKER_NOTIFICATION_HELPERS = new Set([
  "modules/posts/posts-created-effects.service.ts",
  "modules/posts/posts-engagement-effects.service.ts",
]);

/**
 * Request-path files allowed to touch notifications directly, each for a stated reason.
 *
 * Adding an entry here is a deliberate architectural exception — write down *why* the work
 * cannot move to the queue, or move it to the queue instead.
 */
const ALLOWED_DIRECT_NOTIFICATION_USERS: Record<string, string> = {
  "modules/follows/follows-nudge.service.ts":
    "nudge cooldown is read-after-write on the notification row itself",
  "modules/admin/admin-push.controller.ts":
    "admin diagnostic sends only to the requesting admin devices",
  "modules/spaces/spaces.service.ts":
    "space-delete notifications must land before the space row is removed",
};

/** Read/read-state capabilities are intentionally absent: this gate protects writes and delivery. */
const NOTIFICATION_WRITE_CAPABILITIES = [
  "NotificationsService",
  "NotificationWriterService",
  "NotificationCreatorService",
  "NotificationEngagementWriterService",
  "NotificationInviteWriterService",
  "NotificationWriterCommunityService",
  "NotificationWriterFanoutService",
  "NotificationCleanupService",
  "NotificationMarvWriterService",
  "NotificationFanoutContentService",
  "NotificationWriterSupportService",
  "NotificationPushService",
  "NotificationPushDeliveryService",
  "NotificationPushKindService",
  "ApnsPushService",
];
const NOTIFICATION_IMPORT_PATTERN = new RegExp(
  String.raw`\bimport\s+(?:type\s+)?\{[^}]*\b(?:${NOTIFICATION_WRITE_CAPABILITIES.join("|")})\b[^}]*\}\s+from\s*['"][^'"]+['"]`,
);

describe("notification writes go through the side-effects seam", () => {
  it("keeps private notification helpers off request paths", () => {
    const offenders = ALL_TS_FILES.filter((file) => {
      const path = rel(file);
      if (OFF_REQUEST_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix)))
        return false;
      if (WORKER_NOTIFICATION_HELPERS.has(path)) return false;
      return /from\s*['"][^'"]*posts-(?:created|engagement)-effects\.service['"]/.test(
        readFileSync(file, "utf8"),
      );
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it.each(NOTIFICATION_WRITE_CAPABILITIES)(
    "recognizes %s through a barrel or direct import",
    (capability) => {
      expect(
        NOTIFICATION_IMPORT_PATTERN.test(
          `import { ${capability} as Writer } from '../notifications';`,
        ),
      ).toBe(true);
      expect(
        NOTIFICATION_IMPORT_PATTERN.test(
          `import { ${capability} } from "../notifications/notification.service";`,
        ),
      ).toBe(true);
    },
  );

  it("permits consumers of read-only and viewer read-state capabilities", () => {
    expect(
      NOTIFICATION_IMPORT_PATTERN.test(
        "import { NotificationQueryService, NotificationFollowPolicyService, NotificationReadSubjectsService } from '../notifications';",
      ),
    ).toBe(false);
  });

  it("is not imported by request-path services outside the notifications module", () => {
    const offenders = ALL_TS_FILES.filter((file) => {
      const path = rel(file);
      if (path.startsWith("modules/notifications/")) {
        // The module owns these implementations; its controller uses only read/read-state capabilities.
        return false;
      }
      if (OFF_REQUEST_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix)))
        return false;
      if (WORKER_NOTIFICATION_HELPERS.has(path)) return false;
      if (path in ALLOWED_DIRECT_NOTIFICATION_USERS) return false;

      const src = readFileSync(file, "utf8");
      return NOTIFICATION_IMPORT_PATTERN.test(src);
    });

    expect(offenders.map(rel)).toEqual([]);
  });

  it("keeps the allowlist honest — every entry still imports notifications", () => {
    const stale = Object.keys(ALLOWED_DIRECT_NOTIFICATION_USERS).filter(
      (path) => {
        const src = readFileSync(join(SRC_DIR, path), "utf8");
        return !NOTIFICATION_IMPORT_PATTERN.test(src);
      },
    );

    expect(stale).toEqual([]);
  });
});

// ─── Every declared side effect has a handler ────────────────────────────────

describe("side-effect names and handlers stay in sync", () => {
  function declaredNames(): string[] {
    const src = readFileSync(
      join(__dirname, "side-effects.constants.ts"),
      "utf8",
    );
    const body = src.slice(src.indexOf("export interface SideEffectPayloads"));
    return [...body.matchAll(/^ {2}['"]([a-z0-9.\-]+)['"]:/gm)].map(
      (m) => m[1],
    );
  }

  function registeredNames(): string[] {
    const names = new Set<string>();
    for (const file of ALL_TS_FILES) {
      if (rel(file).endsWith(".spec.ts")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(
        /registry\.register\(\s*['"]([a-z0-9.\-]+)['"]/g,
      ))
        names.add(m[1]);
    }
    return [...names];
  }

  it("registers a handler for every declared payload", () => {
    const registered = new Set(registeredNames());
    expect(declaredNames().length).toBeGreaterThan(0);
    // A dispatch with no handler is the worst failure mode here: it enqueues, the processor
    // finds nothing, and the work silently never happens.
    const unhandled = declaredNames().filter((name) => !registered.has(name));

    expect(unhandled).toEqual([]);
  });

  it("does not register a handler for an undeclared name", () => {
    const declared = new Set(declaredNames());
    const undeclared = registeredNames().filter((name) => !declared.has(name));

    expect(undeclared).toEqual([]);
  });
});
