import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { postRankingSql } from "./posts-ranking.sql";
import { friendEngagementSql } from "./posts-friend-engagement.sql";

// Explicitly opt in: this starts an isolated, disposable PostgreSQL cluster, never the app DB.
const postgresTests =
  process.env.RUN_POST_RANKING_SQL_TESTS === "1" ? describe : describe.skip;
postgresTests("post ranking on PostgreSQL", () => {
  let directory: string;
  let started = false;
  let embedded:
    | {
        exec: (
          query: string,
        ) => Promise<Array<{ rows: Array<Record<string, unknown>> }>>;
        close: () => Promise<void>;
      }
    | undefined;
  const now = new Date("2026-09-08T12:00:00Z");
  const literal = (value: unknown): string =>
    value === null
      ? "NULL"
      : typeof value === "number"
        ? String(value)
        : `'${(value instanceof Date ? value.toISOString() : String(value)).replace(/'/g, "''")}'`;
  async function sql(query: string) {
    if (embedded) {
      const results = await embedded.exec(query);
      return results
        .flatMap((result) =>
          result.rows.map((row) =>
            Object.values(row)
              .map((value) =>
                value instanceof Date ? value.toISOString() : String(value),
              )
              .join("|"),
          ),
        )
        .join("\n");
    }
    return execFileSync(
      "psql",
      [
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        directory,
        "-p",
        "55439",
        "-d",
        "postgres",
        "-c",
        query,
      ],
      { encoding: "utf8" },
    ).trim();
  }
  async function execute(query: Prisma.Sql) {
    return sql(
      `DEALLOCATE ALL; PREPARE ranking_test AS ${query.text}; EXECUTE ranking_test(${query.values.map(literal).join(",")});`,
    );
  }
  async function scores(ids: string[]) {
    return new Map(
      (
        await execute(
          postRankingSql(
            Prisma.sql`SELECT "id" FROM "Post" WHERE "id" IN (${Prisma.join(ids)})`,
            now,
          ),
        )
      )
        .split("\n")
        .filter(Boolean)
        .map((row) => {
          const [id, value] = row.split("|");
          return [id!, Number(value)] as const;
        }),
    );
  }
  beforeAll(async () => {
    // Optional external WASM PostgreSQL runtime; no application dependency is added.
    if (process.env.POST_RANKING_PGLITE_MODULE) {
      const { PGlite } = require(process.env.POST_RANKING_PGLITE_MODULE);
      embedded = new PGlite();
    } else {
      directory = mkdtempSync(join(tmpdir(), "moh-ranking-pg-"));
      execFileSync(
        "initdb",
        ["-D", join(directory, "data"), "-A", "trust", "--no-locale"],
        { stdio: "pipe" },
      );
      try {
        execFileSync(
          "pg_ctl",
          [
            "-D",
            join(directory, "data"),
            "-l",
            join(directory, "postgres.log"),
            "-o",
            `-F -k ${directory} -p 55439 -c listen_addresses=''`,
            "-w",
            "start",
          ],
          { stdio: "pipe" },
        );
        started = true;
      } catch (error) {
        throw new Error(
          `${String(error)}\n${readFileSync(join(directory, "postgres.log"), "utf8")}`,
        );
      }
    }
    await sql(`
      CREATE TYPE "PostVisibility" AS ENUM ('public', 'verifiedOnly', 'premiumOnly', 'onlyMe');
      CREATE TABLE "User" ("id" text PRIMARY KEY, "premium" boolean DEFAULT false, "verifiedStatus" text DEFAULT 'identity', "pinnedPostId" text, "createdAt" timestamptz DEFAULT '2020-01-01');
      CREATE TABLE "Post" (
        "id" text PRIMARY KEY, "userId" text DEFAULT 'author', "parentId" text, "rootId" text,
        "repostedPostId" text, "quotedPostId" text, "communityGroupId" text, "deletedAt" timestamptz,
        "createdAt" timestamptz DEFAULT '2026-09-08T12:00:00Z', "visibility" "PostVisibility" DEFAULT 'public',
        "kind" text DEFAULT 'regular', "body" text DEFAULT '', "hashtags" text[] DEFAULT '{}',
        "boostScore" double precision DEFAULT 1, "boostScoreUpdatedAt" timestamptz DEFAULT '2026-09-08T12:00:00Z',
        "boostCount" integer DEFAULT 0, "bookmarkCount" integer DEFAULT 0, "commentCount" integer DEFAULT 0, "weightedViewCount" bigint DEFAULT 0
      );
      CREATE TABLE "Boost" ("postId" text, "userId" text, "createdAt" timestamptz DEFAULT '2026-09-08T12:00:00Z');
      CREATE TABLE "PostPoll" ("postId" text, "totalVoteCount" integer);
      CREATE TABLE "HashtagTrendingScoreSnapshot" ("asOf" timestamptz, "visibility" "PostVisibility", "score" double precision, "tag" text);
    `);
  }, 30000);
  afterAll(async () => {
    if (embedded) await embedded.close();
    if (started)
      execFileSync(
        "pg_ctl",
        ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"],
        { stdio: "pipe" },
      );
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await sql(`TRUNCATE "Post", "User", "Boost", "PostPoll", "HashtagTrendingScoreSnapshot";
      INSERT INTO "User" ("id") VALUES ('author');`);
  });

  it("applies root and content-type multipliers to engagement without a pin", async () => {
    await sql(
      `INSERT INTO "Post" ("id", "parentId", "kind") VALUES ('root', NULL, 'regular'), ('reply', 'missing', 'regular'), ('status', NULL, 'status'), ('checkin', NULL, 'checkin');`,
    );
    const actual = await scores(["root", "reply", "status", "checkin"]);
    expect(actual.get("root")).toBeCloseTo(1.15);
    expect(actual.get("reply")).toBeCloseTo(1);
    expect(actual.get("status")).toBeCloseTo(1.15 * 0.6);
    expect(actual.get("checkin")).toBeCloseTo(1.15 * 0.85);
  });

  it("applies new-account and deleted-ancestor penalties without a pin", async () => {
    await sql(`INSERT INTO "User" ("id", "verifiedStatus", "createdAt") VALUES ('new', 'none', '2026-09-08');
      INSERT INTO "Post" ("id", "userId", "parentId", "deletedAt") VALUES
      ('new-post', 'new', NULL, NULL), ('deleted', 'author', NULL, '2026-09-08'), ('reply', 'author', 'deleted', NULL);`);
    const actual = await scores(["new-post", "reply"]);
    expect(actual.get("new-post")).toBeCloseTo(1.15 * 0.85);
    expect(actual.get("reply")).toBeCloseTo(0.85);
  });

  it("scores a post identically alone and in a scheduled batch", async () => {
    await sql(`INSERT INTO "Post" ("id") VALUES ('one'), ('two');
      INSERT INTO "Post" ("id", "kind", "repostedPostId", "quotedPostId", "boostScore") VALUES
      ('repost', 'repost', 'one', NULL, 0), ('quote', 'regular', NULL, 'one', 0);`);
    expect((await scores(["one"])).get("one")).toBeCloseTo(
      (1 + 0.5 + 0.8) * 1.15,
    );
    expect((await scores(["one", "two"])).get("one")).toBe(
      (await scores(["one"])).get("one"),
    );
  });

  it("returns zero to clear stale scores after engagement is removed", async () => {
    await sql(`INSERT INTO "Post" ("id", "boostScore") VALUES ('zero', 0);`);
    expect((await scores(["zero"])).get("zero")).toBe(0);
  });

  it('caps the engagement-rate multiplier on the whole score', async () => {
    await sql(`INSERT INTO "Post" ("id", "boostCount") VALUES ('rate', 1000);`);
    expect((await scores(['rate'])).get('rate')).toBeCloseTo(1.15 * 1.06);
  });

  it("counts a friend once across repeated replies, boosts, and reposts", async () => {
    await sql(`INSERT INTO "Post" ("id", "userId", "parentId") SELECT 'reply-' || n, 'friend', 'root' FROM generate_series(1, 20) n;
      INSERT INTO "Boost" ("postId", "userId") VALUES ('root', 'friend'), ('root', 'other');
      INSERT INTO "Post" ("id", "userId", "kind", "repostedPostId") VALUES ('repost', 'friend', 'repost', 'root');`);
    const result = (
      await execute(friendEngagementSql(["root"], ["friend", "other"]))
    ).split("|");
    expect(result[0]).toBe("root");
    expect(Number(result[1])).toBe(2);
  });

  it("counts repost-only social proof and uses its latest timestamp", async () => {
    await sql(
      `INSERT INTO "Post" ("id", "userId", "kind", "repostedPostId", "createdAt") VALUES ('repost', 'friend', 'repost', 'root', '2026-09-08T11:00:00Z');`,
    );
    const result = (
      await execute(friendEngagementSql(["root"], ["friend"]))
    ).split("|");
    expect(Number(result[1])).toBe(1);
    expect(new Date(result[2]!).toISOString()).toBe("2026-09-08T11:00:00.000Z");
  });
});
