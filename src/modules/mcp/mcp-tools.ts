import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { z } from 'zod';
import type { AppConfigService } from '../app/app-config.service';
import type { AdminCapabilityDto } from '../../common/dto/admin-assistant.dto';

export type SharedTool = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  execute: (args: unknown) => Promise<Record<string, unknown>>;
};
export type SharedApi = {
  baseUrl: string;
  get: (path: string, query?: Record<string, unknown>) => Promise<Record<string, any>>;
  request: (path: string, options?: { method?: string; body?: unknown }) => Promise<Record<string, any>>;
};
const load = (file: string): any => createRequire(__filename)(resolve(__dirname, `../../../tools/mcp/${file}`));
export const sharedTools = {
  createTools: (options: { api: SharedApi; localArtifacts: false }): SharedTool[] => load('src/tools.mjs').createTools(options),
  capabilities: (): AdminCapabilityDto[] => load('src/admin-catalog.mjs').adminCapabilities,
  schema: (schema: z.ZodTypeAny): Record<string, unknown> => load('node_modules/zod-to-json-schema').zodToJsonSchema(schema, { $refStrategy: 'none' }),
  sanitize: (value: unknown): any => load('src/api.mjs').sanitize(value),
  guidance: (): string => load('src/guidance.mjs').metricGuide,
};

/** Same local HTTP stack and guards for hosted MCP and in-product MARV. */
export function localApiFetch(config: AppConfigService): typeof fetch {
  const baseUrl = config.browserHandoffBaseUrl();
  return (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith('/v1/')) {
      throw new Error('Unsupported local API target.');
    }
    return fetch(new URL(`http://127.0.0.1:${config.port()}${url.pathname}${url.search}`), init);
  };
}

export function sessionApi(config: AppConfigService, token: string, expiresAt: Date): SharedApi {
  const baseUrl = config.browserHandoffBaseUrl();
  const localFetch = localApiFetch(config);
  return new (load('src/api.mjs').MohApi)({
    baseUrl,
    store: {
      credentialName: () => 'admin-request',
      read: async () => ({ baseUrl, token, expiresAt: expiresAt.toISOString() }),
      write: async () => {},
    },
    fetchImpl: (input: Parameters<typeof fetch>[0], init: RequestInit) => localFetch(input, {
      ...init,
      headers: { ...init.headers, Origin: config.frontendBaseUrl() || 'http://localhost:3000' },
    }),
  });
}
