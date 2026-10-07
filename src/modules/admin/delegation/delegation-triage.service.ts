import { Injectable } from "@nestjs/common";
import { choice, noul, score } from "@typesafe-ai/sdk";
import { AppConfigService } from "../../app/app-config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TypeSafeService } from "../../typesafe/typesafe.service";

const URGENCY = ["routine", "soon", "urgent", "critical"] as const;
const BATCH = 5;
const MAX_ITEMS = 30;
const ITEM_BUDGET_MS = 6_000;
/** Below this the classifier is guessing, so the item goes to a person regardless of what it picked. */
const LOW_CONFIDENCE = 0.6;
const NEEDS_HUMAN = 0.5;
const HARM_ESCALATE = 0.3;

export type TriageHint = {
  kind: "feedback" | "report";
  id: string;
  category: string;
  categoryConfidence: number;
  urgency: (typeof URGENCY)[number];
  urgencyScore: number;
  urgencyConfidence: number;
  /** Probability a human admin must decide rather than routine handling. */
  needsHuman: number;
  /** Reports only: probability the report describes a real rule violation. */
  validViolation?: number;
  /** Reports only: probability of threats, self-harm, minors at risk, doxxing, or illegal content. */
  seriousHarm?: number;
  lowConfidence: boolean;
  escalate: boolean;
};

export type TriageHints = {
  engine: "jev";
  note: string;
  items: TriageHint[];
  counts: { total: number; escalate: number; lowConfidence: number };
};

type FeedbackRow = { id: string; subject?: string; details?: string; category?: string };
type ReportRow = { id: string; reason?: string };

/**
 * First-pass triage of admin evidence with Jev. Hints are advisory evidence for the delegated
 * run and the reviewing admin: they never change item status or take any action. Returns null
 * when Jev is off or unreachable and the run proceeds exactly as before.
 */
@Injectable()
export class DelegationTriageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly typeSafe: TypeSafeService,
    private readonly appConfig: AppConfigService,
  ) {}

  available(): boolean {
    return this.typeSafe.isConfigured() && this.appConfig.typeSafe().triageEnabled;
  }

  async hints(evidence: Record<string, unknown>): Promise<TriageHints | null> {
    if (!this.available()) return null;
    const feedback = (Array.isArray(evidence.feedback) ? evidence.feedback : []) as FeedbackRow[];
    const reports = (Array.isArray(evidence.reports) ? evidence.reports : []) as ReportRow[];
    if (!feedback.length && !reports.length) return null;

    const reportIds = reports.slice(0, MAX_ITEMS).map((r) => r.id);
    const details = reportIds.length
      ? await this.prisma.report.findMany({ where: { id: { in: reportIds } }, select: { id: true, details: true } })
      : [];
    const detailsById = new Map(details.map((row) => [row.id, row.details ?? ""]));

    const jobs: Array<() => Promise<TriageHint | null>> = [
      ...feedback.slice(0, MAX_ITEMS).map((row) => () => this.feedbackHint(row)),
      ...reports.slice(0, MAX_ITEMS).map((row) => () => this.reportHint(row, detailsById.get(row.id) ?? "")),
    ];
    const items: TriageHint[] = [];
    for (let i = 0; i < jobs.length; i += BATCH) {
      const settled = await Promise.all(jobs.slice(i, i + BATCH).map((run) => run()));
      for (const hint of settled) if (hint) items.push(hint);
    }
    if (!items.length) return null;

    return {
      engine: "jev",
      note:
        "Fast classifier hints, not decisions. Verify against the item before acting. Items marked escalate or lowConfidence need an admin's judgment.",
      items,
      counts: {
        total: items.length,
        escalate: items.filter((h) => h.escalate).length,
        lowConfidence: items.filter((h) => h.lowConfidence).length,
      },
    };
  }

  private async feedbackHint(row: FeedbackRow): Promise<TriageHint | null> {
    const result = await this.typeSafe.decide({
      purpose: "delegation.triage.feedback",
      timeoutMs: ITEM_BUDGET_MS,
      signal: AbortSignal.timeout(ITEM_BUDGET_MS),
      state: { subject: row.subject ?? "", details: (row.details ?? "").slice(0, 4_000) },
      questions: {
        category: choice("What is this member feedback mainly about?", {
          bug: "Something is broken or behaving incorrectly.",
          feature: "A request or idea for new or changed functionality.",
          billing: "Subscription, payment, refund, or charge problems.",
          account: "Login, verification, profile, or account access problems.",
          safety: "Harassment, threats, abuse, or another member's conduct.",
          praise: "Positive feedback or thanks.",
          other: "Anything else, or too unclear to place.",
        }),
        urgency: score("How urgent is it for the team to respond?", [
          "Routine: no time pressure.",
          "Soon: worth handling within a few days.",
          "Urgent: blocks the member or loses money; handle today.",
          "Critical: safety risk, data exposure, or widespread outage.",
        ]),
        needsHuman: noul("Does this need a human admin's judgment or personal response rather than routine handling?"),
      },
    });
    if (!result) return null;
    const { category, urgency, needsHuman } = result.answers;
    return this.finish({
      kind: "feedback",
      id: row.id,
      category: category.choice,
      categoryConfidence: category.confidence,
      urgencyScore: urgency.score,
      urgencyConfidence: urgency.confidence,
      needsHuman: needsHuman.noul,
    });
  }

  private async reportHint(row: ReportRow, details: string): Promise<TriageHint | null> {
    const result = await this.typeSafe.decide({
      purpose: "delegation.triage.report",
      timeoutMs: ITEM_BUDGET_MS,
      signal: AbortSignal.timeout(ITEM_BUDGET_MS),
      state: { reportedFor: row.reason ?? "other", reporterDetails: details.slice(0, 4_000) },
      questions: {
        category: choice("Which kind of conduct does this report describe?", {
          spam: "Unsolicited promotion, scams, or repetitive junk.",
          harassment: "Targeting, insulting, or intimidating a person.",
          hate: "Attacks on people for who they are.",
          sexual: "Sexual or explicit material.",
          violence: "Threats or depictions of violence or self-harm.",
          illegal: "Evidence of unlawful activity.",
          disagreement: "A difference of opinion or a personal dispute that is not a rule violation.",
          other: "Anything else, or too unclear to place.",
        }),
        urgency: score("How urgent is it for an admin to act?", [
          "Routine: no time pressure.",
          "Soon: worth handling within a few days.",
          "Urgent: ongoing harm to a member; handle today.",
          "Critical: imminent danger, a minor at risk, or exposure of private information.",
        ]),
        validViolation: noul("Does the report describe a real violation of reasonable community rules?"),
        seriousHarm: noul(
          "Does it involve threats, self-harm, a minor at risk, doxxing, or illegal content that needs prompt action?",
        ),
        needsHuman: noul("Is this ambiguous or high-stakes enough that a human admin must decide?"),
      },
    });
    if (!result) return null;
    const { category, urgency, validViolation, seriousHarm, needsHuman } = result.answers;
    return this.finish({
      kind: "report",
      id: row.id,
      category: category.choice,
      categoryConfidence: category.confidence,
      urgencyScore: urgency.score,
      urgencyConfidence: urgency.confidence,
      needsHuman: needsHuman.noul,
      validViolation: validViolation.noul,
      seriousHarm: seriousHarm.noul,
    });
  }

  private finish(input: Omit<TriageHint, "urgency" | "lowConfidence" | "escalate">): TriageHint {
    const level = Math.max(0, Math.min(URGENCY.length - 1, Math.round(input.urgencyScore)));
    const lowConfidence = Math.min(input.categoryConfidence, input.urgencyConfidence) < LOW_CONFIDENCE;
    const escalate =
      lowConfidence ||
      input.needsHuman >= NEEDS_HUMAN ||
      level >= 2 ||
      (input.seriousHarm ?? 0) >= HARM_ESCALATE;
    return { ...input, urgency: URGENCY[level]!, lowConfidence, escalate };
  }
}
