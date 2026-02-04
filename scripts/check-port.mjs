#!/usr/bin/env node
const { execSync } = require('child_process');

const port = String(process.env.PORT || '3001');

try {
  const pid = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (pid) {
    console.error(`Port ${port} is already in use (pid ${pid}).`);
    console.error(`Kill it with: npm run dev:kill (or: kill -9 ${pid})`);
    process.exit(1);
  }
} catch {
  // Port is free or lsof returned no matches.
  process.exit(0);
}
