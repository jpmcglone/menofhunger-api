#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = realpathSync(
  path.resolve(path.dirname(SCRIPT_PATH), ".."),
);
const DEFAULT_PORT = "3001";
const STOP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;
const LSOF_TIMEOUT_MS = 2000;

function systemAdapter() {
  return {
    listListeners(port) {
      try {
        return execFileSync(
          "lsof",
          ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
          {
            encoding: "utf8",
            stdio: "pipe",
            timeout: LSOF_TIMEOUT_MS,
          },
        );
      } catch (error) {
        if (
          error.status === 1 &&
          !String(error.stdout ?? "").trim() &&
          !String(error.stderr ?? "").trim()
        )
          return "";
        throw error;
      }
    },
    cwdForPid(pid) {
      const output = execFileSync(
        "lsof",
        ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        {
          encoding: "utf8",
          stdio: "pipe",
          timeout: LSOF_TIMEOUT_MS,
        },
      );
      const names = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1));
      if (names.length !== 1 || !names[0])
        throw new Error(
          `Could not determine the working directory for pid ${pid}.`,
        );
      return names[0];
    },
    realpath: realpathSync,
    signal(pid, signal) {
      process.kill(pid, signal);
    },
    sleep(milliseconds) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        milliseconds,
      );
    },
  };
}

function parsePort(value) {
  const raw = String(value ?? DEFAULT_PORT);
  if (!/^\d+$/.test(raw))
    throw new Error(
      `Invalid port ${JSON.stringify(raw)}; expected an integer from 1 to 65535.`,
    );
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port ${JSON.stringify(raw)}; expected an integer from 1 to 65535.`,
    );
  }
  return String(port);
}

function parsePids(output) {
  const lines = String(output).trim().split(/\s+/).filter(Boolean);
  const pids = lines.map((line) => {
    if (!/^\d+$/.test(line) || Number(line) < 1)
      throw new Error(`lsof returned an invalid process id: ${line}`);
    return Number(line);
  });
  return [...new Set(pids)];
}

function inspectListeners(pids, repositoryRoot, adapter) {
  return pids.map((pid) => {
    const cwd = adapter.realpath(adapter.cwdForPid(pid));
    if (cwd !== repositoryRoot)
      throw new Error(
        `Refusing to stop port listener pid ${pid}: its working directory is ${cwd}, outside this repository.`,
      );
    return pid;
  });
}

export function stopPort({
  port: rawPort,
  repositoryRoot = REPOSITORY_ROOT,
  adapter = systemAdapter(),
  timeoutMs = STOP_TIMEOUT_MS,
} = {}) {
  let port;
  let canonicalRoot;
  try {
    port = parsePort(rawPort ?? process.env.PORT ?? DEFAULT_PORT);
    canonicalRoot = adapter.realpath(repositoryRoot);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  let initialPids;
  try {
    initialPids = parsePids(adapter.listListeners(port));
  } catch (error) {
    console.error(`Could not inspect port ${port}: ${error.message}`);
    return 1;
  }
  if (initialPids.length === 0) return 0;

  try {
    inspectListeners(initialPids, canonicalRoot, adapter);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  // Re-read and validate every current listener before signaling any process.
  let currentPids;
  try {
    currentPids = parsePids(adapter.listListeners(port));
    inspectListeners(currentPids, canonicalRoot, adapter);
  } catch (error) {
    console.error(`Refusing to stop port ${port}: ${error.message}`);
    return 1;
  }
  if (currentPids.length === 0) return 0;

  try {
    for (const pid of currentPids) {
      // Verify the process is still a listener with the same repository cwd just before signaling.
      const latestPids = parsePids(adapter.listListeners(port));
      if (!latestPids.includes(pid)) continue;
      const cwd = adapter.realpath(adapter.cwdForPid(pid));
      if (cwd !== canonicalRoot)
        throw new Error(
          `Refusing to stop port listener pid ${pid}: its working directory changed to ${cwd}.`,
        );
      adapter.signal(pid, "SIGTERM");
    }
  } catch (error) {
    console.error(`Could not safely stop port ${port}: ${error.message}`);
    return 1;
  }

  for (let elapsed = 0; elapsed < timeoutMs; elapsed += POLL_INTERVAL_MS) {
    let remaining;
    try {
      remaining = parsePids(adapter.listListeners(port));
    } catch (error) {
      console.error(`Could not confirm port ${port} stopped: ${error.message}`);
      return 1;
    }
    if (remaining.length === 0) return 0;
    adapter.sleep(Math.min(POLL_INTERVAL_MS, timeoutMs - elapsed));
  }

  let remaining;
  try {
    remaining = parsePids(adapter.listListeners(port));
  } catch (error) {
    console.error(`Could not confirm port ${port} stopped: ${error.message}`);
    return 1;
  }
  if (remaining.length > 0) {
    console.error(
      `Port ${port} is still in use after SIGTERM (pid${remaining.length === 1 ? "" : "s"} ${remaining.join(", ")}).`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = stopPort();
}
