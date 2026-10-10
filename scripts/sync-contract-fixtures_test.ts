import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  fixtureOptions,
  fixtureOutputs,
  syncFixtures,
} from "./sync-contract-fixtures";

test("explicit worktree fixtures are copied exactly and drift is read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "moh-fixtures-"));
  try {
    const api = join(root, "menofhunger-api");
    const ios = join(root, "active-ios");
    const android = join(root, "android");
    for (const repo of [
      api,
      ios,
      android,
      join(root, "menofhunger-ios"),
      join(root, "menofhunger-www"),
    ])
      mkdirSync(repo);
    const outputs = fixtureOutputs(api, ios, android);
    assert.equal(
      outputs.has(
        resolve(
          root,
          "menofhunger-ios/MenOfHungerTests/Fixtures/release-contracts.json",
        ),
      ),
      false,
    );
    assert.deepEqual(syncFixtures(outputs, false), []);
    assert.deepEqual(syncFixtures(outputs, true), []);
    const canonical = join(api, "contracts/fixtures/android.json");
    const copy = join(android, "app/src/test/resources/android-contracts.json");
    assert.deepEqual(readFileSync(copy), readFileSync(canonical));
    const release = JSON.parse(
      readFileSync(join(api, "contracts/fixtures/release.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(release).sort(), [
      "billing",
      "deletion",
      "marvin",
    ]);
    writeFileSync(copy, "drift\n");
    assert.deepEqual(syncFixtures(outputs, true), [copy]);
    assert.equal(readFileSync(copy, "utf8"), "drift\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkout overrides reject missing values and absent roots", () => {
  assert.throws(
    () => fixtureOptions(["--android-root"]),
    /requires a checkout path/,
  );
  assert.throws(
    () => fixtureOptions(["--ios-root", "--check"]),
    /requires a checkout path/,
  );
  assert.throws(
    () => fixtureOptions(["--android-root", "/nonexistent-moh-checkout"]),
    /Missing checkout/,
  );
  assert.deepEqual(fixtureOptions(["--check"]), { check: true });
});
