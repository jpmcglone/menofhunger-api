import type { DelegationAction, DelegationJob } from "@prisma/client";
import type { DelegationActionDto } from "../../../common/dto/delegation.dto";
import { actionSchema, type RunSnapshot } from "./delegation.schemas";

export function snapshot(job: DelegationJob): RunSnapshot {
  const {
    ownerId,
    actorId,
    title,
    workflow,
    schedule,
    instruction,
    permission,
    revision,
  } = job;
  return {
    ownerId,
    actorId,
    title,
    workflow,
    schedule,
    instruction,
    permission,
    revision,
  };
}

export function actionDto(a: DelegationAction): DelegationActionDto {
  // Read-only history survives removal; this operation cannot be executed.
  if (a.operation === "github_issue")
    return {
      id: a.id,
      operation: a.operation,
      title: a.title,
      preview:
        "GitHub issue creation has been removed. Issue tracking uses Linear.",
      body: null,
      status: a.status === "pending" ? "cancelled" : a.status,
      receipt: a.receipt,
      path: a.path,
      sources: [],
      createdAt: a.createdAt.toISOString(),
    };
  const input = actionSchema.parse(a.input);
  let preview = Object.entries(input)
    .filter(([k]) => k !== "operation" && k !== "sources")
    .map(
      ([k, v]) =>
        `${k.replace(/([A-Z])/g, " $1")}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
    )
    .join("\n\n");
  const before = a.before as Record<string, unknown>;
  const context = ["subject", "name", "title", "body"]
    .filter((key) => typeof before[key] === "string")
    .map((key) => `${key}: ${before[key]}`)
    .join("\n");
  if (context) preview += `\n\nCurrent item:\n${context}`;
  if (Array.isArray(before.media) && before.media.length)
    preview += `\n\nAttached media: ${before.media.length} item(s), preserved from the selected draft.`;
  return {
    id: a.id,
    exportFormat: input.operation === "export" ? input.format : undefined,
    operation: a.operation,
    title: a.title,
    preview,
    body: "body" in input ? input.body : null,
    status: a.status,
    receipt: a.receipt,
    path: a.path,
    sources: "sources" in input ? input.sources : [],
    createdAt: a.createdAt.toISOString(),
  };
}
