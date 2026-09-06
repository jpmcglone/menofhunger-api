#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { MohApi } from './api.mjs';
import { StateStore } from './state.mjs';
import { createTools } from './tools.mjs';
import { instructions, metricGuide, workflows } from './guidance.mjs';

export function createServer({ api, store } = {}) {
  store ??= new StateStore();
  api ??= new MohApi({ store });
  const server = new McpServer(
    { name: 'menofhunger', version: '0.1.0' },
    { instructions },
  );
  for (const tool of createTools({ api, store })) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: !tool.localWrite,
          destructiveHint: false,
          idempotentHint: !tool.localWrite,
          openWorldHint: !tool.localWrite,
        },
      },
      async (args) => {
        try {
          const result = await tool.execute(args);
          const text = JSON.stringify(result);
          if (text.length > 120_000)
            throw new Error(
              'Result is too large. Choose a narrower analytics area or a smaller page limit.',
            );
          return {
            content: [{ type: 'text', text }],
            structuredContent: result,
          };
        } catch (error) {
          // Validation details can echo member-provided content; expose only the safe summary.
          const text =
            error.name === 'ZodError'
              ? 'Invalid tool arguments. Check the tool input schema.'
              : error.message;
          return { isError: true, content: [{ type: 'text', text }] };
        }
      },
    );
  }
  for (const [name, text] of Object.entries({
    guide: instructions,
    metrics: metricGuide,
  })) {
    server.registerResource(
      name,
      `moh://${name}`,
      { mimeType: 'text/plain', description: `Men of Hunger ${name}` },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/plain', text }],
      }),
    );
  }
  for (const [name, text] of Object.entries(workflows)) {
    server.registerPrompt(name, { description: text }, async () => ({
      messages: [{ role: 'user', content: { type: 'text', text } }],
    }));
  }
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  Promise.resolve()
    .then(() => createServer().connect(new StdioServerTransport()))
    .catch(() => {
      process.stderr.write(
        'Men of Hunger MCP failed to start. Check its local configuration.\n',
      );
      process.exitCode = 1;
    });
}
