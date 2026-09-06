import { readFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { configuredBaseUrl } from './config.mjs';

export const aliases = {
  status: ['connection_status'],
  capabilities: ['admin_capabilities'],
  workspace: ['admin_workspace', 'workspace'],
  briefing: ['founder_briefing'],
  analytics: ['analytics'],
  referrals: ['referral_analytics'],
  feedback: ['feedback'],
  reports: ['reports'],
  queues: ['queue_health'],
  health: ['operations_health'],
  members: ['search_members', 'q'],
  member: ['member_profile', 'username'],
  diagnose: ['member_diagnostics', 'memberId'],
  grants: ['member_grants', 'memberId'],
  'member-referrals': ['member_referrals', 'memberId'],
  content: ['public_content'],
  newsletters: ['newsletters', 'newsletterId'],
  definitions: ['metric_definitions'],
  decision: ['record_decision'],
  decisions: ['list_decisions'],
  draft: ['save_draft'],
  drafts: ['list_drafts'],
};

export function describeTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    command: Object.entries(aliases).find(
      ([, [name]]) => name === tool.name,
    )?.[0],
    description: tool.description,
    effects: tool.localWrite ? 'local-file-write' : 'read',
    inputSchema: zodToJsonSchema(tool.schema, { $refStrategy: 'none' }),
  }));
}

export async function parseCommand(argv) {
  const tokens = [...argv];
  let profile;
  const envIndex = tokens.indexOf('--env');
  if (envIndex !== -1) {
    profile = tokens[envIndex + 1];
    if (!profile) throw new Error('Choose --env prod or --env local.');
    configuredBaseUrl(profile);
    tokens.splice(envIndex, 2);
    if (tokens.includes('--env')) throw new Error('Specify --env only once.');
  }
  const json = tokens.includes('--json');
  const help = tokens.includes('--help') || tokens.includes('-h');
  const filtered = tokens.filter(
    (value) => !['--json', '--help', '-h'].includes(value),
  );
  const command = filtered.shift() || 'help';
  if (
    ['help', 'tools', 'login', 'logout', 'configure', 'version'].includes(
      command,
    )
  ) {
    if (filtered.length)
      throw new Error(`Unexpected arguments for ${command}.`);
    return { command, json, help, profile };
  }
  // Exact tool names and the generic call interface are supported for AI agents.
  const requested = command === 'call' ? filtered.shift() : command;
  const [toolName, positionalKey] = aliases[requested] || [requested];
  let args = {};
  if (command === 'call' && filtered[0]?.startsWith('{'))
    args = JSON.parse(filtered.shift());
  else if (positionalKey && filtered[0] && !filtered[0].startsWith('--'))
    args[positionalKey] = filtered.shift();
  while (filtered.length) {
    const flag = filtered.shift();
    if (!/^--[a-z][a-zA-Z-]*$/.test(flag))
      throw new Error(`Expected an option, received ${flag}. Use --help.`);
    const key = flag
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === 'input') {
      if (
        Object.keys(args).length ||
        !filtered[0] ||
        filtered[0].startsWith('--')
      )
        throw new Error('Use --input FILE without additional tool arguments.');
      const file = await readFile(filtered.shift(), 'utf8');
      if (file.length > 100_000) throw new Error('Input JSON exceeds 100 KB.');
      args = JSON.parse(file);
      if (filtered.length)
        throw new Error('Use --input FILE without additional tool arguments.');
      break;
    }
    if (Object.hasOwn(args, key)) throw new Error(`Duplicate option: ${flag}`);
    const raw =
      filtered[0] && !filtered[0].startsWith('--') ? filtered.shift() : 'true';
    // Only the actual numeric/boolean options are coerced; a numeric search stays text.
    args[key] =
      key === 'limit'
        ? Number(raw)
        : key === 'unanswered'
          ? raw === 'true'
            ? true
            : raw === 'false'
              ? false
              : raw
          : raw;
  }
  return { command, toolName, args, json, help, profile };
}

export const helpText = `Men of Hunger — founder CLI and MCP

From the API project: npm run --silent moh -- <command> [options]
Optional global command: npm install --global ./tools/mcp, then moh <command>

  login                              Sign in with SMS (hidden interactive input)
  configure                          Register this MCP installation with local Codex
  logout                             Revoke this session and remove local credentials
  status                             Verify administrator identity and API readiness
  briefing [--range 7d]               Business, community, support, and operations
  analytics --area retention          Drill into metrics (default range: 7d)
  members "search text"               Find a member; --limit and --cursor supported
  member USERNAME                     Inspect an exact member account summary
  diagnose MEMBER_ID                  Access, billing providers, grants, activity
  grants MEMBER_ID                    Complimentary membership balance
  member-referrals MEMBER_ID          Individual referral information
  feedback --status new               Member feedback; optional --category and --q
  reports --status pending            Moderation queue for human review
  health                             Support totals and operational issues
  queues                             Background job queue health
  content --unanswered --limit 20     Public posts needing a response
  content --q "leadership"            Public content research, up to a 31-day window
  referrals                          Referral metrics
  newsletters [ID]                   Newsletter summaries or one existing draft
  definitions                        Metric windows and interpretation
  decision --input decision.json     Save an adopted decision locally
  decisions                          Read local decision history
  draft --input draft.json           Save a local draft; never sends or publishes
  drafts                             Read local drafts
  tools [--json]                     Discover every tool and its input schema
  call TOOL '{"key":"value"}'        Invoke any tool using its MCP name/schema

Add --json for a stable { ok, data, error } envelope. Nonzero exit means failure.
Add --env prod (default) or --env local to any command. Local calls localhost:3001/v1.
Examples: moh --env local login; moh --env local configure; moh --env prod briefing.
Add --help to any command for its exact input schema. Hyphenated flags map to camelCase.
Ranges: 7d, 30d, 3m, 1y, all. Areas: overview, retention, activity, membership,
content, community, ai, coins. Timestamps are ISO UTC, e.g. 2026-09-01T00:00:00Z.

MOH_API_BASE_URL defaults to https://api.menofhunger.com/v1.
MOH_MCP_STATE_DIR sets the private session/draft/decision directory.
New diagnostics/content endpoints require deploying the accompanying API change.
No remote writes or automatic monitoring. No OpenAI API key needed.
`;

export function formatHuman(result) {
  if (typeof result?.definitions === 'string' && !result.data)
    return result.definitions;
  if (Object.hasOwn(result ?? {}, 'connected')) {
    return (
      `${result.connected ? 'Connected' : 'Not connected'}: ${result.environment}\n` +
      (result.identity
        ? `Administrator: @${result.identity.username || result.identity.id}\nDiagnostics: ${result.diagnostics.available ? 'available' : result.diagnostics.reason}\n`
        : `${result.nextStep}\n`)
    );
  }
  if (result?.sections) {
    const sections = result.sections;
    const business = sections.business?.available
      ? sections.business.data
      : null;
    const summary = business?.summary;
    const health = sections.operations_health?.available
      ? sections.operations_health.data
      : null;
    const lines = [
      `Men of Hunger — ${result.range} briefing`,
      `Fetched: ${result.asOf}`,
      `API: ${result.environment}`,
      '',
    ];
    const number = (value) =>
      typeof value === 'number' ? value.toLocaleString('en-US') : 'unavailable';
    if (summary) {
      lines.push(
        `Members: ${number(summary.totalUsers)} | Verified: ${number(summary.verifiedUsers)}`,
        `Average daily active: ${number(summary.dau)} | Monthly active: ${number(summary.mau)}`,
        `Premium access: ${number(summary.premiumUsers)} (includes ${number(summary.premiumPlusUsers)} Premium+; includes grants)`,
        `30-day retention: ${business.engagement?.d30RetentionPct == null ? 'not measurable' : `${business.engagement.d30RetentionPct}%`} | Cohort: ${number(business.engagement?.d30CohortSize)}`,
      );
    }
    if (health)
      lines.push(
        '',
        `New feedback: ${number(health.feedback?.new)} | Triaged: ${number(health.feedback?.triaged)} | Pending reports: ${number(health.pendingReports)}`,
        `Stripe events unprocessed >15 minutes: ${number(health.stripeWebhooks?.olderThan15Minutes)}`,
        `Scheduled posts with failures: ${number(health.scheduledPostsWithFailures)}`,
      );
    for (const name of ['feedback', 'reports']) {
      if (sections[name]?.available && Array.isArray(sections[name].data)) {
        const rows = sections[name].data;
        lines.push(
          '',
          `${name === 'feedback' ? 'Feedback' : 'Reports'} sample (${rows.length} shown):`,
        );
        for (const row of rows.slice(0, 5))
          lines.push(
            `  ${row.id}  ${String(row.subject || row.reason || row.status || 'Review needed').slice(0, 140)}`,
          );
        if (rows.length > 5)
          lines.push(`  ${rows.length - 5} more in --json output.`);
      }
    }
    const queues = sections.queue_health?.available
      ? sections.queue_health.data?.queues
      : null;
    if (queues) {
      lines.push('', 'Queues:');
      for (const queue of queues)
        lines.push(
          queue.error
            ? `  ${queue.name}: unavailable (${queue.error})`
            : `  ${queue.name}: workers=${number(queue.workers)}, waiting=${number(queue.waiting)}, failed=${number(queue.failed)}${queue.paused ? ', PAUSED' : ''}`,
        );
    }
    for (const [name, section] of Object.entries(sections))
      if (!section.available)
        lines.push(`Unavailable — ${name}: ${section.reason}`);
    lines.push('', 'Sources:');
    for (const [name, section] of Object.entries(sections))
      if (section.source?.url) lines.push(`  ${name}: ${section.source.url}`);
    lines.push(
      '',
      'Membership is a current access snapshot, not revenue. Use --json for all evidence, referrals, and limitations.',
      'Run analytics --area retention --range 30d, feedback, reports, or health to investigate.',
    );
    return lines.join('\n');
  }
  // Preserve the entire evidence payload for drilldowns.
  return JSON.stringify(result, null, 2);
}
