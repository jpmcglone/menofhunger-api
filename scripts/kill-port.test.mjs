import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { stopPort } from "./kill-port.mjs";

const repositoryRoot = path.resolve("/repo/api");

function fakeAdapter({ pids = [], cwdByPid = {}, onList, onSignal } = {}) {
  const state = { pids: [...pids], signals: [], listCalls: 0 };
  return {
    state,
    adapter: {
      listListeners(port) {
        state.listCalls += 1;
        onList?.(state, port);
        return state.pids.join("\n");
      },
      cwdForPid(pid) {
        return cwdByPid[pid] ?? repositoryRoot;
      },
      realpath(value) {
        return path.resolve(value);
      },
      signal(pid, signal) {
        state.signals.push([pid, signal]);
        onSignal?.(state, pid, signal);
      },
      sleep() {},
    },
  };
}

function run(options) {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    return { code: stopPort(options), errors };
  } finally {
    console.error = originalError;
  }
}

test("rejects invalid ports before inspecting processes", () => {
  const fake = fakeAdapter();
  const result = run({
    port: "3001;kill-all",
    repositoryRoot,
    adapter: fake.adapter,
  });
  assert.equal(result.code, 1);
  assert.equal(fake.state.listCalls, 0);
  assert.deepEqual(fake.state.signals, []);
});

test("succeeds when the port has no listeners", () => {
  const fake = fakeAdapter();
  const result = run({ port: 3001, repositoryRoot, adapter: fake.adapter });
  assert.equal(result.code, 0);
  assert.deepEqual(fake.state.signals, []);
});

test("sends SIGTERM to a repository listener and waits for it to exit", () => {
  const fake = fakeAdapter({
    pids: [123],
    onSignal(state, pid) {
      state.pids = state.pids.filter((candidate) => candidate !== pid);
    },
  });
  const result = run({ port: 3001, repositoryRoot, adapter: fake.adapter });
  assert.equal(result.code, 0);
  assert.deepEqual(fake.state.signals, [[123, "SIGTERM"]]);
});

test("allows a listener time to exit after SIGTERM", () => {
  const fake = fakeAdapter({
    pids: [123],
    onList(state) {
      if (state.signals.length > 0 && state.listCalls >= 5) state.pids = [];
    },
  });
  const result = run({
    port: 3001,
    repositoryRoot,
    adapter: fake.adapter,
    timeoutMs: 300,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(fake.state.signals, [[123, "SIGTERM"]]);
});

test("refuses unrelated or mixed listeners before signaling any process", () => {
  const fake = fakeAdapter({
    pids: [123, 456],
    cwdByPid: { 456: "/repo/other-service" },
  });
  const result = run({ port: 3001, repositoryRoot, adapter: fake.adapter });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(" "), /outside this repository/);
  assert.deepEqual(fake.state.signals, []);
});

test("rechecks repository identity immediately before signaling", () => {
  const fake = fakeAdapter({
    pids: [123],
    cwdByPid: { 123: repositoryRoot },
    onList(state) {
      if (state.listCalls === 3)
        fake.adapter.cwdForPid = () => "/repo/other-service";
    },
  });
  const result = run({ port: 3001, repositoryRoot, adapter: fake.adapter });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(" "), /working directory changed/);
  assert.deepEqual(fake.state.signals, []);
});

test("returns an error when a listener remains after SIGTERM", () => {
  const fake = fakeAdapter({ pids: [123] });
  const result = run({
    port: 3001,
    repositoryRoot,
    adapter: fake.adapter,
    timeoutMs: 0,
  });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(" "), /still in use after SIGTERM/);
  assert.deepEqual(fake.state.signals, [[123, "SIGTERM"]]);
});

test("reports process-inspection failures instead of treating them as an unused port", () => {
  const fake = fakeAdapter();
  fake.adapter.listListeners = () => {
    throw new Error("lsof unavailable");
  };
  const result = run({ port: 3001, repositoryRoot, adapter: fake.adapter });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(" "), /lsof unavailable/);
});

test("refuses to signal when the listener working directory cannot be inspected", () => {
  const fake = fakeAdapter({ pids: [123] });
  fake.adapter.cwdForPid = () => {
    throw new Error("permission denied");
  };
  const result = run({ port: 3001, repositoryRoot, adapter: fake.adapter });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(" "), /permission denied/);
  assert.deepEqual(fake.state.signals, []);
});

test("reports signal failures", () => {
  const fake = fakeAdapter({ pids: [123] });
  fake.adapter.signal = () => {
    throw new Error("operation not permitted");
  };
  const result = run({ port: 3001, repositoryRoot, adapter: fake.adapter });
  assert.equal(result.code, 1);
  assert.match(result.errors.join(" "), /operation not permitted/);
});
