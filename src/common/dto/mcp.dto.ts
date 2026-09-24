/** One authorized AI client (ChatGPT, Claude, Cursor…) on the hosted MCP endpoint. */
export type McpConnectionItemDto = {
  /** Opaque, non-secret identifier used only to revoke this connection. */
  id: string;
  /** Name the AI client registered with, such as "ChatGPT". Client-supplied; display as text. */
  clientName: string;
  audience: 'admin' | 'member';
  createdAt: string | null;
  /** Last authenticated MCP request. Null until the client first uses the connection. */
  lastUsedAt: string | null;
  /** When the 30-day authorization ends and the client must reconnect. */
  expiresAt: string;
};

export type McpUsageDto = {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
};

/** How the signed-in person can connect an AI client to Men of Hunger over MCP. */
export type McpConnectionDto = {
  /** Hosted MCP endpoint to paste into ChatGPT, Claude, or Cursor. */
  url: string;
  /** `member` is the read-only Premium catalog; `admin` is the founder catalog; null means not eligible. */
  audience: 'admin' | 'member' | null;
  /** Member tool-call allowance for the current UTC day. Null for admins and ineligible accounts. */
  usage: McpUsageDto | null;
  /** Connected AI clients, newest first. Kept even after Premium ends so they can be removed. */
  connections: McpConnectionItemDto[];
};

/** A member's hosted MCP connections as seen from the admin user page. */
export type AdminMcpConnectionsDto = {
  /** Member tool calls counted today. Administrators are never counted. */
  usage: McpUsageDto;
  connections: McpConnectionItemDto[];
};

export type McpRevokeResultDto = { revoked: true };
