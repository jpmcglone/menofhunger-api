#!/usr/bin/env node
const { execSync } = require('child_process');

const port = String(process.env.PORT || '3001');

try {
  const pids = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (!pids) process.exit(0);
  execSync(`echo "${pids}" | xargs -r kill -9`, { stdio: 'ignore' });
} catch {
  process.exit(0);
}
