/**
 * One-shot local Marv runner. Boots the real Nest stack (prompt builder, tools,
 * OpenAI) without HTTP or job consumers, then prints the reply.
 *
 *   npm run marv:try -- "What's new on Men of Hunger?"
 *   npm run marv:try -- --suite
 *   npm run marv:try -- --as cslewis --mode regular --dump-prompt "What did John mean?"
 *
 * Does not post replies, spend credits, or write usage events.
 */
process.env.RUN_JOB_CONSUMERS = 'false';
process.env.RUN_HTTP = 'false';
process.env.RUN_SCHEDULERS = 'false';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { AppConfigService } from '../src/modules/app/app-config.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { MarvinAIService } from '../src/modules/marvin/services/marvin-ai.service';
import {
  MarvinPromptBuilderService,
  type MarvPromptInput,
  type MarvPromptUser,
  type MarvThreadPost,
} from '../src/modules/marvin/services/marvin-prompt-builder.service';
import { MarvinRoutingService } from '../src/modules/marvin/services/marvin-routing.service';
import { MarvinToolHandlersService } from '../src/modules/marvin/services/marvin-tool-handlers.service';
import type { ResolvedMarvinMode } from '../src/modules/marvin/services/marvin-routing.service';
import type { MarvAIResult } from '../src/modules/marvin/services/marvin-ai.service';

type RequestedMode = 'auto' | ResolvedMarvinMode;
type Source = 'public_thread' | 'private_session';

type CliArgs = {
  question: string;
  asUsername: string;
  requested: RequestedMode;
  source: Source;
  suite: boolean;
  caseId: string | null;
  dumpPrompt: boolean;
  help: boolean;
};

type FixtureUser = MarvPromptUser;

type CaseResult = {
  id: string;
  title: string;
  question: string;
  mode: ResolvedMarvinMode;
  routingReason: string;
  tools: string[];
  reply: string;
  words: number;
  tokens: { in: number | null; out: number | null; reasoning: number | null };
  costUsd: number | null;
  failures: string[];
};

const DEFAULT_ASKER = 'cslewis';

function usage(): string {
  return [
    'Usage:',
    '  npm run marv:try -- "<question>"',
    '  npm run marv:try -- --suite',
    '  npm run marv:try -- --suite --case identity',
    '  npm run marv:try -- --as cslewis --mode regular "What did John mean?"',
    '',
    'Flags:',
    '  --suite            Run the built-in live checks (real OpenAI)',
    '  --case <id>        With --suite, run one case',
    '  --as <username>    Requester (default: cslewis for suite, jpmcglone otherwise)',
    '  --mode <tier>      auto | fast | regular | smart  (default: auto)',
    '  --source <src>     public_thread | private_session  (default: public_thread)',
    '  --dump-prompt      Print the developer note and exit (no OpenAI call)',
    '  --help             Show this help',
  ].join('\n');
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    question: '',
    asUsername: '',
    requested: 'auto',
    source: 'public_thread',
    suite: false,
    caseId: null,
    dumpPrompt: false,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--suite') {
      out.suite = true;
    } else if (arg === '--dump-prompt') {
      out.dumpPrompt = true;
    } else if (arg === '--as') {
      out.asUsername = (argv[++i] ?? '').trim();
    } else if (arg === '--mode') {
      const mode = (argv[++i] ?? '').trim().toLowerCase();
      if (mode !== 'auto' && mode !== 'fast' && mode !== 'regular' && mode !== 'smart') {
        throw new Error(`Unknown --mode ${mode}. Use auto, fast, regular, or smart.`);
      }
      out.requested = mode;
    } else if (arg === '--source') {
      const source = (argv[++i] ?? '').trim();
      if (source !== 'public_thread' && source !== 'private_session') {
        throw new Error(`Unknown --source ${source}. Use public_thread or private_session.`);
      }
      out.source = source;
    } else if (arg === '--case') {
      out.caseId = (argv[++i] ?? '').trim() || null;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  out.question = positional.join(' ').trim();
  if (!out.asUsername) {
    out.asUsername = out.suite ? DEFAULT_ASKER : 'jpmcglone';
  }
  return out;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function fakePost(partial: Partial<MarvThreadPost> & Pick<MarvThreadPost, 'body'>): MarvThreadPost {
  return {
    id: `try_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    authorUsername: null,
    authorDisplayName: null,
    ...partial,
  };
}

function mentionsHandle(text: string, username: string): boolean {
  return new RegExp(`@${username}\\b`, 'i').test(text);
}

function thirdPersonMarv(text: string): boolean {
  return /\b(?:marv|m\.a\.r\.v\.)\s+(?:thinks|thought|said|says|believes|would|is a)\b/i.test(text);
}

function citesScripture(text: string): boolean {
  return (
    /\b(?:genesis|exodus|leviticus|numbers|deuteronomy|psalms?|proverbs|isaiah|matthew|mark|luke|acts|romans|galatians|ephesians|philippians|colossians|hebrews|james|revelation)\s+\d/i.test(
      text,
    ) || /\b(?:gen|ex|lev|num|deut|ps|prov|isa|matt|rom|gal|eph|phil|col|heb|jas|rev)\.?\s+\d+:\d+/i.test(text)
  );
}

async function lookupUser(prisma: PrismaService, username: string): Promise<FixtureUser> {
  const row = await prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' } },
    select: { id: true, username: true, name: true },
  });
  if (!row) {
    throw new Error(`No local user @${username}. Run npm run seed:dev, or pass --as <username>.`);
  }
  return { userId: row.id, username: row.username, displayName: row.name };
}

async function boot(): Promise<{
  app: INestApplicationContext;
  ai: MarvinAIService;
  promptBuilder: MarvinPromptBuilderService;
  routing: MarvinRoutingService;
  tools: MarvinToolHandlersService;
  prisma: PrismaService;
  appConfig: AppConfigService;
}> {
  const { AppModule } = await import('../src/modules/app/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  return {
    app,
    ai: app.get(MarvinAIService),
    promptBuilder: app.get(MarvinPromptBuilderService),
    routing: app.get(MarvinRoutingService),
    tools: app.get(MarvinToolHandlersService),
    prisma: app.get(PrismaService),
    appConfig: app.get(AppConfigService),
  };
}

async function runTurn(opts: {
  ai: MarvinAIService;
  promptBuilder: MarvinPromptBuilderService;
  routing: MarvinRoutingService;
  tools: MarvinToolHandlersService;
  appConfig: AppConfigService;
  requester: FixtureUser;
  question: string;
  requested: RequestedMode;
  source: Source;
  ancestors?: MarvThreadPost[];
  triggeringPost?: MarvThreadPost;
  descendants?: MarvThreadPost[];
  dumpPrompt?: boolean;
}): Promise<{
  built: { developerNote: string; userMessage: string };
  routed: ReturnType<MarvinRoutingService['resolve']>;
  result: MarvAIResult | null;
  toolsUsed: string[];
}> {
  const triggeringPost =
    opts.triggeringPost ??
    fakePost({
      body: opts.question,
      authorUsername: opts.requester.username,
      authorDisplayName: opts.requester.displayName,
      isTriggeringPost: true,
    });
  const input: MarvPromptInput = {
    source: opts.source,
    requester: opts.requester,
    currentQuestion: opts.question,
    ancestors: opts.ancestors,
    triggeringPost,
    descendants: opts.descendants,
  };
  const built = opts.promptBuilder.build(input);
  const routed = opts.routing.resolve({
    requested: opts.requested,
    source: opts.source,
    estimatedInputTokens: opts.routing.estimateTokens(`${built.developerNote}\n${built.userMessage}`),
    text: opts.question,
    distinctAuthors: new Set(
      [opts.requester.username, ...(opts.ancestors ?? []).map((p) => p.authorUsername)].filter(Boolean),
    ).size,
    webSearchEnabled: opts.appConfig.marvOpenAI().webSearchEnabled,
  });

  if (opts.dumpPrompt) {
    return { built, routed, result: null, toolsUsed: [] };
  }

  const toolsUsed: string[] = [];
  const result = await opts.ai.respond({
    source: opts.source,
    mode: routed.mode,
    developerNote: built.developerNote,
    userMessage: built.userMessage,
    dispatchTool: async (name, args, ctx) => {
      toolsUsed.push(name);
      return opts.tools.dispatch(name, args, ctx);
    },
    toolContext: {
      requesterUserId: opts.requester.userId,
      requesterUsername: opts.requester.username,
    },
    elevateReasoning: MarvinRoutingService.shouldElevateReasoning(routed),
    cacheKey: `marv-try:${opts.requester.userId}`,
  });
  return { built, routed, result, toolsUsed };
}

function printTurn(label: string, turn: Awaited<ReturnType<typeof runTurn>>): void {
  const { built, routed, result, toolsUsed } = turn;
  console.log(`\n=== ${label} ===`);
  console.log(`mode=${routed.mode} reason=${routed.reason}`);
  if (!result) {
    console.log('\n--- developer note ---\n');
    console.log(built.developerNote);
    console.log('\n--- user message ---\n');
    console.log(built.userMessage);
    return;
  }
  console.log(`model=${result.modelUsed}`);
  console.log(`tools=${toolsUsed.length ? toolsUsed.join(', ') : '(none)'}`);
  console.log(
    `tokens in=${result.inputTokens ?? '-'} out=${result.outputTokens ?? '-'} reasoning=${result.reasoningTokens ?? '-'}  cost=${
      result.estimatedCostUsd != null ? `$${result.estimatedCostUsd.toFixed(4)}` : '-'
    }`,
  );
  console.log(`words=${wordCount(result.text)}`);
  if (result.errorCode) console.log(`errorCode=${result.errorCode}`);
  console.log('\n--- reply ---\n');
  console.log(result.text.trim() || '(empty)');
}

type SuiteDeps = {
  ai: MarvinAIService;
  promptBuilder: MarvinPromptBuilderService;
  routing: MarvinRoutingService;
  tools: MarvinToolHandlersService;
  prisma: PrismaService;
  appConfig: AppConfigService;
  asker: FixtureUser;
  requested: RequestedMode;
};

async function runSuite(deps: SuiteDeps, onlyId: string | null): Promise<CaseResult[]> {
  const locke = await lookupUser(deps.prisma, 'johnlocke').catch(() => null);
  const calvin = await lookupUser(deps.prisma, 'johncalvin').catch(() => null);
  const publicRootCount = await deps.prisma.post.count({
    where: { visibility: 'public', parentId: null, communityGroupId: null, deletedAt: null },
  });

  type CaseDef = {
    id: string;
    title: string;
    question: string;
    requested?: RequestedMode;
    skip?: string;
    ancestors?: MarvThreadPost[];
    triggeringPost?: MarvThreadPost;
    descendants?: MarvThreadPost[];
    expect: (reply: string, toolsUsed: string[]) => string[];
  };

  const cases: CaseDef[] = [
    {
      id: 'identity',
      title: 'First person — he is Marv',
      question: '@marv do you still think that?',
      ancestors: [
        fakePost({
          body: 'Discipline beats motivation. Do the work when you do not feel like it.',
          isMarv: true,
        }),
      ],
      expect: (reply) => {
        const fails: string[] = [];
        if (thirdPersonMarv(reply)) fails.push('spoke about Marv in the third person');
        if (!/\b(i|me|my|yes|still)\b/i.test(reply)) fails.push('did not speak in the first person');
        if (wordCount(reply) > 80) fails.push(`over 80 words (${wordCount(reply)})`);
        return fails;
      },
    },
    {
      id: 'nearest-john',
      title: 'John = nearest in-thread John',
      question: '@marv what did John mean by that?',
      skip: !locke || !calvin ? 'need @johnlocke and @johncalvin (npm run seed:dev)' : undefined,
      ancestors: locke && calvin
        ? [
            fakePost({
              body: 'Election is the foundation. God chooses; we respond.',
              authorUsername: calvin.username,
              authorDisplayName: calvin.displayName,
            }),
            fakePost({
              body: 'Discipline is choosing the harder good when appetite pulls the other way.',
              authorUsername: locke.username,
              authorDisplayName: locke.displayName,
            }),
          ]
        : undefined,
      expect: (reply, toolsUsed) => {
        const fails: string[] = [];
        if (!locke) return ['missing @johnlocke'];
        if (!mentionsHandle(reply, locke.username ?? 'johnlocke')) {
          fails.push(`did not name @${locke.username} (nearest John)`);
        }
        if (calvin && mentionsHandle(reply, calvin.username ?? 'johncalvin')) {
          fails.push(`named farther John @${calvin.username} instead of the nearest`);
        }
        if (toolsUsed.includes('find_members_by_name')) {
          fails.push('called find_members_by_name even though John is in the roster');
        }
        if (wordCount(reply) > 80) fails.push(`over 80 words (${wordCount(reply)})`);
        return fails;
      },
    },
    {
      id: 'theology',
      title: 'Baptist on infant baptism when asked',
      question: 'Is infant baptism biblical?',
      expect: (reply) => {
        const fails: string[] = [];
        const lower = reply.toLowerCase();
        const rejectsPaedo =
          /not biblical|unbiblical|reject|no\b|against|infant baptism is not|paedobaptism is not|believer/.test(lower);
        const bothSides = /both (are |can be )?(valid|biblical|true)|equally (valid|true|biblical)/.test(lower);
        if (!rejectsPaedo) fails.push('did not reject infant baptism');
        if (bothSides) fails.push('treated both views as equally true');
        if (wordCount(reply) > 80) fails.push(`over 80 words (${wordCount(reply)})`);
        return fails;
      },
    },
    {
      id: 'public-posts',
      title: 'Lodge feed via list_public_posts',
      question: "What's new on Men of Hunger?",
      expect: (reply, toolsUsed) => {
        const fails: string[] = [];
        if (!toolsUsed.includes('list_public_posts')) {
          fails.push('did not call list_public_posts');
        }
        if (/could(?:n'?t| not) retrieve|don'?t have access|can'?t (see|access) (the )?(feed|lodge|posts)/i.test(reply)) {
          fails.push('failed to read the lodge feed after calling the tool');
        }
        if (publicRootCount > 0 && /no (public )?posts|nothing new|empty|quiet/i.test(reply)) {
          fails.push(`claimed the lodge is empty but ${publicRootCount} public roots exist`);
        }
        if (wordCount(reply) > 80) fails.push(`over 80 words (${wordCount(reply)})`);
        return fails;
      },
    },
    {
      id: 'concise',
      title: 'One-word-capable answer',
      question: 'What is 2+2?',
      expect: (reply) => {
        const fails: string[] = [];
        if (!/\b4\b/.test(reply)) fails.push('did not say 4');
        if (wordCount(reply) > 20) fails.push(`padded a one-fact answer (${wordCount(reply)} words)`);
        return fails;
      },
    },
    {
      id: 'no-preach',
      title: 'No unprompted Scripture',
      question: 'Should I go to the gym today?',
      expect: (reply) => {
        const fails: string[] = [];
        if (citesScripture(reply)) fails.push('cited Scripture without being asked');
        if (wordCount(reply) > 80) fails.push(`over 80 words (${wordCount(reply)})`);
        return fails;
      },
    },
  ];

  const selected = onlyId ? cases.filter((c) => c.id === onlyId) : cases;
  if (onlyId && selected.length === 0) {
    throw new Error(`Unknown --case ${onlyId}. Known: ${cases.map((c) => c.id).join(', ')}`);
  }

  const results: CaseResult[] = [];
  for (const c of selected) {
    if (c.skip) {
      console.log(`\n=== ${c.id} SKIP: ${c.skip} ===`);
      results.push({
        id: c.id,
        title: c.title,
        question: c.question,
        mode: 'fast',
        routingReason: 'skipped',
        tools: [],
        reply: '',
        words: 0,
        tokens: { in: null, out: null, reasoning: null },
        costUsd: null,
        failures: [`skipped: ${c.skip}`],
      });
      continue;
    }
    console.log(`\n>>> running ${c.id}…`);
    const turn = await runTurn({
      ai: deps.ai,
      promptBuilder: deps.promptBuilder,
      routing: deps.routing,
      tools: deps.tools,
      appConfig: deps.appConfig,
      requester: deps.asker,
      question: c.question,
      requested: c.requested ?? deps.requested,
      source: 'public_thread',
      ancestors: c.ancestors,
      triggeringPost: c.triggeringPost,
      descendants: c.descendants,
    });
    const reply = turn.result?.text ?? '';
    const failures = turn.result?.errorCode
      ? [`ai error: ${turn.result.errorCode}`]
      : c.expect(reply, turn.toolsUsed);
    const row: CaseResult = {
      id: c.id,
      title: c.title,
      question: c.question,
      mode: turn.routed.mode,
      routingReason: turn.routed.reason,
      tools: turn.toolsUsed,
      reply,
      words: wordCount(reply),
      tokens: {
        in: turn.result?.inputTokens ?? null,
        out: turn.result?.outputTokens ?? null,
        reasoning: turn.result?.reasoningTokens ?? null,
      },
      costUsd: turn.result?.estimatedCostUsd ?? null,
      failures,
    };
    results.push(row);
    printTurn(c.id, turn);
    console.log(failures.length ? `\nFAIL: ${failures.join('; ')}` : '\nPASS');
  }
  return results;
}

function printSuiteSummary(results: CaseResult[]): void {
  console.log('\n======== suite ========');
  for (const r of results) {
    const mark = r.failures.length ? 'FAIL' : 'PASS';
    const tools = r.tools.length ? r.tools.join(',') : 'no-tools';
    console.log(`${mark}  ${r.id.padEnd(14)}  ${r.mode.padEnd(8)}  ${String(r.words).padStart(3)}w  ${tools}`);
    if (r.failures.length) {
      for (const f of r.failures) console.log(`      - ${f}`);
    }
  }
  const failed = results.filter((r) => r.failures.length).length;
  const cost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  console.log(`\n${results.length - failed}/${results.length} passed   ~$${cost.toFixed(4)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.suite && !args.question) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  const ctx = await boot();
  try {
    if (!ctx.ai.isConfigured()) {
      throw new Error('Marv is not configured. Need OPENAI_API_KEY and OPENAI_MARV_PROMPT_ID in .env.');
    }
    const requester = await lookupUser(ctx.prisma, args.asUsername);
    const models = ctx.appConfig.marvOpenAI();
    console.log(
      `marv-try  as=@${requester.username}  models=${models.fastModel}/${models.regularModel}/${models.smartModel}  prompt=${models.promptVersion ?? 'latest'}`,
    );

    if (args.suite) {
      const results = await runSuite(
        {
          ai: ctx.ai,
          promptBuilder: ctx.promptBuilder,
          routing: ctx.routing,
          tools: ctx.tools,
          prisma: ctx.prisma,
          appConfig: ctx.appConfig,
          asker: requester,
          requested: args.requested,
        },
        args.caseId,
      );
      printSuiteSummary(results);
      if (results.some((r) => r.failures.length)) process.exitCode = 1;
      return;
    }

    const turn = await runTurn({
      ai: ctx.ai,
      promptBuilder: ctx.promptBuilder,
      routing: ctx.routing,
      tools: ctx.tools,
      appConfig: ctx.appConfig,
      requester,
      question: args.question,
      requested: args.requested,
      source: args.source,
      dumpPrompt: args.dumpPrompt,
    });
    printTurn('ad-hoc', turn);
  } finally {
    await ctx.app.close();
  }
}

main().catch((err) => {
  Logger.error(err instanceof Error ? err.stack ?? err.message : String(err), 'marv-try');
  process.exitCode = 1;
});
