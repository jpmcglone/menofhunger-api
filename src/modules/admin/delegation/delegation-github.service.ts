import { BadRequestException, Injectable } from "@nestjs/common";
import { AppConfigService } from "../../app/app-config.service";
import { PrismaService } from "../../prisma/prisma.service";

/** One explicitly configured repository; no caller-controlled hosts or credential exposure. */
@Injectable()
export class DelegationGithubService {
  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}
  availability() {
    const c = this.config.delegationGithub();
    return { available: Boolean(c), repository: c?.repository ?? null };
  }
  async create(input: { feedbackId: string; title: string; body: string }) {
    const c = this.config.delegationGithub();
    if (!c)
      throw new BadRequestException(
        "Connect the GitHub repository in server settings first.",
      );
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: input.feedbackId },
      select: { id: true },
    });
    if (!feedback)
      throw new BadRequestException("This feedback is no longer available.");
    const response = await fetch(
      `https://api.github.com/repos/${c.repository}/issues`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${c.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: input.title,
          body: `${input.body}\n\nFeedback: ${this.config.frontendBaseUrl()}/admin/feedback?feedbackId=${encodeURIComponent(input.feedbackId)}`,
        }),
      },
    );
    if ([400, 401, 403, 404, 422].includes(response.status))
      throw new BadRequestException(
        "GitHub rejected this issue. Check repository access and the reviewed text.",
      );
    if (!response.ok)
      throw new Error(
        "GitHub issue outcome is uncertain. Check the repository before retrying.",
      );
    const issue = (await response.json()) as { number?: number };
    if (!Number.isInteger(issue.number) || issue.number! < 1)
      throw new Error("GitHub returned an unconfirmed issue result.");
    return {
      receipt: `GitHub issue #${issue.number} created.`,
      path: `https://github.com/${c.repository}/issues/${issue.number}`,
    };
  }
  async read(url: string) {
    const c = this.config.delegationGithub();
    if (!c) return { available: false };
    const prefix = `https://github.com/${c.repository}/issues/`;
    if (!url.startsWith(prefix) || !/^\d+$/.test(url.slice(prefix.length)))
      throw new BadRequestException("Unsupported issue link.");
    const response = await fetch(
      `https://api.github.com/repos/${c.repository}/issues/${url.slice(prefix.length)}`,
      {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
        headers: {
          Authorization: `Bearer ${c.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) return { available: false, url };
    const issue = (await response.json()) as {
      state: string;
      state_reason: string | null;
      updated_at: string;
      closed_at: string | null;
    };
    return {
      available: true,
      url,
      state: issue.state,
      reason: issue.state_reason,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
    };
  }
}
