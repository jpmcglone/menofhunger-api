import { PrismaService } from "../prisma/prisma.service";
import type { XArticleDraft } from "./x-article-content";
import { mapXProfile } from "./x-profile-preview.mapper";
import { xContainsLink } from "../../common/crosspost/crosspost-eligibility";
import { createHash, randomBytes } from "crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_API_BASE = "https://api.x.com";
export const X_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
];

export class XApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** True when a retry could post a second copy. The worker records the error and stops. */
    readonly duplicateRisk = false,
  ) {
    super(message);
  }

  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Retry only when we know X did not accept the post. */
  get isRetryable(): boolean {
    return !this.duplicateRisk && (this.status === 429 || this.status >= 500);
  }
}

export type XTokenPair = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
};

export type XPostPayload = {
  text: string;
  mediaIds?: string[];
  allowLinks?: boolean;
  poll?: { options: string[]; duration_minutes: number };
  replyToId?: string | null;
  quoteId?: string | null;
  previousId?: string | null;
};

export type XAccount = { id: string; username: string };

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const REQUIRED_X_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
];

/** X granted every scope this integration posts with. An empty scope list is not enough. */
export function hasRequiredXScopes(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return REQUIRED_X_SCOPES.every((name) => granted.has(name));
}

/** Handles X will actually accept. Anything else is not stored on the profile. */
export function isXUsername(username: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(username);
}

@Injectable()
export class XApiClient {
  private readonly logger = new Logger(XApiClient.name);
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  authorizeUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: X_SCOPES.join(" "),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${X_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<XTokenPair> {
    return this.parseTokens(
      await this.tokenRequest(input.clientId, input.clientSecret, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
    );
  }

  async refresh(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<XTokenPair> {
    return this.parseTokens(
      await this.tokenRequest(input.clientId, input.clientSecret, {
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
    );
  }

  async revoke(input: {
    clientId: string;
    clientSecret: string;
    token: string;
  }): Promise<void> {
    try {
      await this.tokenRequest(
        input.clientId,
        input.clientSecret,
        {
          token: input.token,
          token_type_hint: "refresh_token",
        },
        "/2/oauth2/revoke",
      );
    } catch (err) {
      this.logger.warn(
        `X revoke failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getMe(accessToken: string): Promise<XAccount> {
    const json = await this.request("GET", "/2/users/me", { accessToken });
    const data = (
      json as { data?: { id?: unknown; username?: unknown } } | null
    )?.data;
    const id = typeof data?.id === "string" ? data.id : "";
    const username =
      typeof data?.username === "string" ? data.username.replace(/^@/, "") : "";
    if (!id || !username)
      throw new XApiError(502, "bad_response", "X did not return an account.");
    return { id, username };
  }

  async uploadImage(
    accessToken: string,
    file: { bytes: Buffer; contentType: string; alt: string | null },
  ): Promise<string> {
    const alt = (file.alt ?? "").trim();
    if (alt.length > 1000)
      throw new XApiError(
        400,
        "alt_too_long",
        "Shorten photo alt text to 1,000 characters for X.",
      );
    const form = new FormData();
    form.append(
      "media",
      new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
      "image",
    );
    form.append("media_category", "tweet_image");
    const json = await this.request("POST", "/2/media/upload", {
      accessToken,
      form,
    });
    const data = (json as { data?: { id?: unknown } } | null)?.data;
    const id = typeof data?.id === "string" ? data.id : "";
    if (!id)
      throw new XApiError(502, "bad_response", "X did not return a media id.");
    if (alt) {
      await this.request("POST", "/2/media/metadata", {
        accessToken,
        body: { id, metadata: { alt_text: { text: alt } } },
      });
    }
    return id;
  }

  /** Streams at most one 5 MiB segment at a time. No full-video buffer or blind retries. */
  async uploadMovingMedia(
    accessToken: string,
    source: Response,
    category: "tweet_video" | "tweet_gif",
    beforeRequest: () => Promise<void>,
  ): Promise<string> {
    const size = Number(source.headers.get("content-length"));
    const mediaType = source.headers.get("content-type")?.split(";")[0];
    const maximum =
      category === "tweet_gif" ? 15 * 1024 * 1024 : 500 * 1024 * 1024;
    if (
      !source.ok ||
      !source.body ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > maximum ||
      !(category === "tweet_gif"
        ? mediaType === "image/gif"
        : ["video/mp4", "video/quicktime", "video/webm"].includes(
            mediaType ?? "",
          ))
    ) {
      await source.body?.cancel();
      throw new XApiError(
        400,
        "media_invalid",
        "This upload does not meet X media requirements.",
      );
    }
    const reader = source.body.getReader();
    const deadline = Date.now() + 90_000;
    const request = async (
      method: "GET" | "POST",
      path: string,
      options: { body?: unknown; form?: FormData } = {},
    ) => {
      if (Date.now() >= deadline)
        throw new XApiError(
          408,
          "media_timeout",
          "X media processing timed out. Review before retrying.",
          true,
        );
      await beforeRequest();
      return this.request(method, path, {
        accessToken,
        ...options,
      }) as Promise<{
        data?: {
          id?: string;
          processing_info?: { state?: string; check_after_secs?: number };
        };
      }>;
    };
    try {
      const initialized = await request("POST", "/2/media/upload/initialize", {
        body: {
          total_bytes: size,
          media_type: mediaType,
          media_category: category,
        },
      });
      const id = initialized?.data?.id;
      if (!id || !/^\d{1,19}$/.test(id))
        throw new XApiError(
          502,
          "bad_response",
          "X did not confirm a media ID.",
          true,
        );
      const segmentSize = 5 * 1024 * 1024;
      let segment = Buffer.alloc(segmentSize),
        offset = 0,
        total = 0,
        index = 0;
      const append = async () => {
        const form = new FormData();
        form.append("segment_index", String(index++));
        form.append(
          "media",
          new Blob([new Uint8Array(segment.subarray(0, offset))]),
          "segment",
        );
        await request("POST", `/2/media/upload/${id}/append`, { form });
        offset = 0;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > size)
          throw new XApiError(
            400,
            "media_invalid",
            "Media size changed during upload.",
          );
        for (let cursor = 0; cursor < value.length; ) {
          const count = Math.min(segmentSize - offset, value.length - cursor);
          segment.set(value.subarray(cursor, cursor + count), offset);
          offset += count;
          cursor += count;
          if (offset === segmentSize) await append();
        }
      }
      if (total !== size)
        throw new XApiError(
          400,
          "media_invalid",
          "Media upload was incomplete.",
        );
      if (offset) await append();
      segment = Buffer.alloc(0);
      let result = await request("POST", `/2/media/upload/${id}/finalize`);
      for (let checks = 0; result.data?.processing_info; checks++) {
        const info = result.data.processing_info;
        if (info.state === "succeeded") return id;
        if (
          info.state === "failed" ||
          !["pending", "in_progress"].includes(info.state ?? "") ||
          checks >= 10
        )
          throw new XApiError(
            400,
            "media_processing",
            "X could not process this media.",
          );
        const delay = Math.min(
          5000,
          Math.max(1000, (info.check_after_secs ?? 1) * 1000),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        result = await request(
          "GET",
          `/2/media/upload?media_id=${id}&command=STATUS`,
        );
      }
      return id;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async getPublicPostMetrics(accessToken: string, id: string) {
    const json = (await this.request(
      "GET",
      `/2/tweets/${encodeURIComponent(id)}?tweet.fields=public_metrics,withheld`,
      { accessToken },
    )) as {
      data?: {
        id?: string;
        withheld?: unknown;
        public_metrics?: Record<string, unknown>;
      };
    };
    if (
      json?.data?.id !== id ||
      json.data.withheld ||
      !json.data.public_metrics
    )
      return null;
    const result: {
      likes?: number;
      replies?: number;
      reposts?: number;
      quotes?: number;
      impressions?: number;
    } = {};
    for (const [field, source] of [
      ["likes", "like_count"],
      ["replies", "reply_count"],
      ["reposts", "retweet_count"],
      ["quotes", "quote_count"],
      ["impressions", "impression_count"],
    ] as const) {
      const value = json.data.public_metrics[source];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        result[field] = value;
    }
    return result;
  }

  async createArticleDraft(
    accessToken: string,
    draft: XArticleDraft,
  ): Promise<string> {
    const response = (await this.request("POST", "/2/articles/draft", {
      accessToken,
      body: draft,
    })) as { data?: { id?: unknown } };
    const id = response?.data?.id;
    if (typeof id !== "string" || !/^\d+$/.test(id))
      throw new XApiError(
        502,
        "bad_response",
        "X did not confirm the draft ID.",
        true,
      );
    return id;
  }

  async publishArticle(accessToken: string, id: string): Promise<string> {
    const response = (await this.request(
      "POST",
      `/2/articles/${encodeURIComponent(id)}/publish`,
      { accessToken },
    )) as { data?: { post_id?: unknown } };
    const postId = response?.data?.post_id;
    if (typeof postId !== "string" || !/^\d+$/.test(postId))
      throw new XApiError(
        502,
        "bad_response",
        "X did not confirm the published Article ID.",
        true,
      );
    return postId;
  }

  async getNews(accessToken: string, query: string): Promise<unknown> {
    const params = new URLSearchParams({
      query,
      max_results: "5",
      max_age_hours: "24",
      "news.fields":
        "id,name,summary,cluster_posts_results,disclaimer,updated_at",
    });
    return this.request("GET", `/2/news/search?${params}`, { accessToken });
  }

  async getProfileContext(accessToken: string, id: string) {
    const json = (await this.request(
      "GET",
      `/2/users/${encodeURIComponent(id)}?user.fields=receives_your_dm,connection_status,protected,withheld`,
      { accessToken },
    )) as {
      data?: {
        id?: unknown;
        receives_your_dm?: unknown;
        connection_status?: unknown;
        protected?: unknown;
        withheld?: unknown;
      };
    };
    const data = json?.data;
    if (data?.id !== id || data.protected !== false || data.withheld)
      return null;
    const status = Array.isArray(data.connection_status)
      ? data.connection_status
      : [];
    return {
      targetId: id,
      followsYou: status.includes("followed_by"),
      following: status.includes("following"),
      messageUrl:
        data.receives_your_dm === true &&
        !status.includes("blocking") &&
        /^\d+$/.test(id)
          ? `https://x.com/messages/compose?recipient_id=${id}`
          : null,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  async getPublicProfileByUsername(accessToken: string, username: string) {
    if (!isXUsername(username)) return null;
    const fields =
      "description,profile_image_url,profile_banner_url,url,verified,public_metrics,protected,withheld";
    const json = (await this.request(
      "GET",
      `/2/users/by/username/${encodeURIComponent(username)}?user.fields=${fields}`,
      { accessToken },
    )) as { data?: { id?: unknown; username?: unknown } };
    if (
      typeof json?.data?.id !== "string" ||
      typeof json.data.username !== "string" ||
      json.data.username.toLowerCase() !== username.toLowerCase()
    )
      return null;
    return mapXProfile(json.data, json.data.id);
  }

  async getPublicProfile(accessToken: string, id: string) {
    const fields =
      "description,profile_image_url,profile_banner_url,url,verified,public_metrics,protected,withheld";
    const json = (await this.request(
      "GET",
      `/2/users/${encodeURIComponent(id)}?user.fields=${fields}`,
      { accessToken },
    )) as { data?: unknown };
    return mapXProfile(json?.data, id);
  }

  async createPost(
    accessToken: string,
    payload: XPostPayload,
  ): Promise<string> {
    if (xContainsLink(payload.text) && !payload.allowLinks) {
      throw new XApiError(
        400,
        "links_unsupported",
        "Remove any links to post to X.",
      );
    }
    const body: Record<string, unknown> = { text: payload.text };
    if (payload.mediaIds?.length) body.media = { media_ids: payload.mediaIds };
    if (payload.poll) body.poll = payload.poll;
    if (payload.replyToId)
      body.reply = { in_reply_to_tweet_id: payload.replyToId };
    if (payload.quoteId) body.quote_tweet_id = payload.quoteId;
    if (payload.previousId)
      body.edit_options = { previous_post_id: payload.previousId };
    let json: unknown;
    try {
      json = await this.request("POST", "/2/tweets", { accessToken, body });
    } catch (err) {
      if (err instanceof XApiError && (err.status === 0 || err.status >= 500)) {
        throw new XApiError(0, err.code, err.message, true);
      }
      throw err;
    }
    const id = (json as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof id !== "string" || !/^\d{1,19}$/.test(id))
      throw new XApiError(
        502,
        "bad_response",
        "X did not return a post id.",
        true,
      );
    return id;
  }

  async deletePost(accessToken: string, id: string) {
    try {
      const result = (await this.request(
        "DELETE",
        `/2/tweets/${encodeURIComponent(id)}`,
        { accessToken },
      )) as { data?: { deleted?: boolean } } | null;
      if (result?.data?.deleted !== true)
        throw new XApiError(
          502,
          "removal_unconfirmed",
          "X did not confirm removal.",
        );
    } catch (e) {
      if (!(e instanceof XApiError) || e.status !== 404) throw e;
    }
  }

  private async tokenRequest(
    clientId: string,
    clientSecret: string,
    fields: Record<string, string>,
    path = "/2/oauth2/token",
  ): Promise<unknown> {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    return this.request("POST", path, {
      bodyEncoded: new URLSearchParams(fields).toString(),
      basic,
    });
  }

  private parseTokens(json: unknown): XTokenPair {
    const o = (json && typeof json === "object" ? json : {}) as Record<
      string,
      unknown
    >;
    const accessToken =
      typeof o.access_token === "string" ? o.access_token : "";
    if (!accessToken)
      throw new XApiError(
        502,
        "bad_response",
        "X did not return an access token.",
      );
    const expiresIn =
      typeof o.expires_in === "number" && o.expires_in > 0
        ? o.expires_in
        : 7200;
    return {
      accessToken,
      refreshToken:
        typeof o.refresh_token === "string" && o.refresh_token
          ? o.refresh_token
          : null,
      expiresInSeconds: expiresIn,
      scope: typeof o.scope === "string" ? o.scope : "",
    };
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: {
      accessToken?: string;
      basic?: string;
      body?: unknown;
      bodyEncoded?: string;
      form?: FormData;
    },
  ): Promise<unknown> {
    if (
      !path.startsWith("/2/oauth2/") &&
      this.prisma &&
      (
        await this.prisma.integrationSpendControl.findUnique({
          where: { id: "global" },
        })
      )?.paused
    ) {
      throw new XApiError(
        409,
        "spending_paused",
        "Integration spending is paused.",
      );
    }
    const headers: Record<string, string> = {};
    if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
    if (opts.basic) headers.Authorization = `Basic ${opts.basic}`;
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.bodyEncoded !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = opts.bodyEncoded;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(`${X_API_BASE}${path}`, {
        method,
        redirect: "error",
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new XApiError(
        0,
        "network_error",
        err instanceof Error ? err.message : "Could not reach X.",
      );
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const record = json as {
        detail?: string;
        title?: string;
        errors?: Array<{ message?: string }>;
      } | null;
      const message =
        record?.errors?.[0]?.message ||
        record?.detail ||
        record?.title ||
        `X responded with ${res.status}.`;
      throw new XApiError(res.status, "request_failed", message);
    }
    if (!path.startsWith("/2/oauth2/"))
      this.logger.log(`${method} ${path} -> ${res.status}`);
    if (method === "DELETE" && res.status === 204)
      return { data: { deleted: true } };
    return json;
  }
}
