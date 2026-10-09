import { MessagesCallsService } from "../messages";
import { CallBudgetService } from "./call-budget.service";
import { Injectable, Logger, Inject } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { AppConfigService } from "../app/app-config.service";
import { z } from "zod";
import type {
  SfuAckDto,
  SfuRequestDto,
  SfuTrackKind,
} from "../../common/dto/call.dto";
import { RedisService } from "../redis/redis.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { CallSessionStore, type CallSessionRecord } from "./call-session.store";
import { SfuProviderError, SfuProviderService } from "./sfu-provider.service";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const requestSchema = z
  .object({
    callId: id,
    connectionId: id,
    action: z.enum([
      "open",
      "publish",
      "subscribe",
      "answer",
      "close",
      "data",
      "unpublish",
      "ready",
    ]),
    data: z.string().max(1024).optional(),
    remoteUserId: id.optional(),
    sessionDescription: z
      .object({
        type: z.enum(["offer", "answer"]),
        sdp: z.string().min(1).max(200_000),
      })
      .optional(),
    tracks: z
      .array(
        z.object({
          kind: z.enum(["audio", "video", "screen"]),
          mid: z.string().min(1).max(32),
        }),
      )
      .max(3)
      .optional(),
  })
  .strict();
type Connection = {
  connectionId: string;
  sessionId: string;
  seatId: string;
  tracks: Array<{ kind: SfuTrackKind; mid: string }>;
  source?: {
    userId: string;
    connectionId: string;
    seatId: string;
    tracks: string;
  };
  awaitingAnswer?: boolean;
  invalid?: boolean;
  ready?: boolean;
};
type Connections = Record<string, Connection>;
const key = (callId: string, userId: string) => `call:sfu:${callId}:${userId}`;
const failure = (code: string, message: string): SfuAckDto => ({
  error: { code, message },
});

/** Bounded per-seat SFU state. Clients address MOH users and track kinds, never arbitrary provider sessions. */
@Injectable()
export class SfuService {
  private readonly logger = new Logger(SfuService.name);
  constructor(
    private readonly provider: SfuProviderService,
    private readonly store: CallSessionStore,
    private readonly redis: RedisService,
    @Inject(MessagesCallsService)
    private readonly messages: Pick<
      MessagesCallsService,
      "getCallConversationContext"
    >,
    private readonly realtime: PresenceRealtimeService,
    private readonly config: AppConfigService,
    private readonly budget: CallBudgetService,
  ) {}

  enabled(): boolean {
    return this.provider.enabled();
  }

  async handle(
    userId: string,
    socketId: string,
    raw: unknown,
  ): Promise<SfuAckDto> {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success)
      return failure("invalid_payload", "Invalid call request.");
    const request = parsed.data;
    try {
      const record = await this.authorize(userId, socketId, request.callId);
      if (!record)
        return failure("not_allowed", "This call is no longer available.");
      if (
        ["open", "publish", "subscribe"].includes(request.action) &&
        !(await this.budget.allowsAllocation(record.id))
      ) {
        return failure(
          "calling_unavailable",
          "Calling is temporarily unavailable. Please try again later.",
        );
      }
      if (request.action === "data") {
        if (!request.data)
          return failure("invalid_payload", "Invalid call reaction.");
        const bucket = `call:sfu:reaction:${userId}:${Math.floor(Date.now() / 1000)}`;
        const count = await this.redis.raw().incr(bucket);
        await this.redis.raw().expire(bucket, 2);
        if (count > 5)
          return failure(
            "rate_limited",
            "Please wait before sending another reaction.",
          );
        for (const participant of record.participants) {
          if (participant.userId !== userId)
            this.realtime.emitRtcSignal(participant.userId, {
              callId: record.id,
              fromUserId: userId,
              data: request.data,
              fromSessionId:
                record.participants.find((p) => p.userId === userId)
                  ?.sessionId ?? undefined,
            });
        }
        return {};
      }
      const result = await this.redis.withLock(
        `lock:${key(request.callId, userId)}`,
        { ttlMs: 30_000, waitMs: 100 },
        async () => {
          // Re-read after lock acquisition: a seat can move while another operation is in flight.
          const current = await this.authorize(
            userId,
            socketId,
            request.callId,
          );
          if (!current)
            return failure("not_allowed", "This call is no longer available.");
          return this.operate(current, userId, socketId, request);
        },
      );
      return result ?? failure("busy", "Call connection is busy. Try again.");
    } catch (error) {
      const reason =
        error instanceof SfuProviderError ? error.message : "internal";
      const role = request.remoteUserId ? "subscriber" : "publisher";
      this.logger.warn(
        `[calls] SFU failed action=${request.action} role=${role} reason=${reason}`,
      );
      return failure(
        "connection_failed",
        "Couldn’t connect the call. Please try again.",
      );
    }
  }

  private async authorize(
    userId: string,
    socketId: string,
    callId: string,
  ): Promise<CallSessionRecord | null> {
    const call = await this.store.getByCallId(callId);
    if (!call || call.mediaTransport !== "sfu" || call.status === "ended")
      return null;
    if (
      !call.participants.some(
        (p) => p.userId === userId && p.socketId === socketId && p.sessionId,
      )
    )
      return null;
    const context = await this.messages.getCallConversationContext({
      userId,
      conversationId: call.conversationId,
    });
    const member = context.participants.find((p) => p.userId === userId);
    return member && !member.banned && member.status === "accepted"
      ? call
      : null;
  }

  private async operate(
    call: CallSessionRecord,
    userId: string,
    socketId: string,
    request: SfuRequestDto,
  ): Promise<SfuAckDto> {
    const seat = call.participants.find((p) => p.userId === userId)!;
    const seatId = `${seat.sessionId}:${seat.joinedAt}`;
    const state =
      (await this.redis.getJson<Connections>(key(call.id, userId))) ?? {};
    const slot = request.remoteUserId ?? "publisher";
    if (
      request.remoteUserId &&
      (request.remoteUserId === userId ||
        !call.participants.some((p) => p.userId === request.remoteUserId))
    ) {
      return failure("not_allowed", "This participant has left the call.");
    }
    let connection = state[slot];
    if (request.action === "open") {
      if (
        connection?.connectionId === request.connectionId &&
        connection.seatId === seatId
      )
        return connection.invalid
          ? failure("connection_expired", "Reconnect this call.")
          : {};
      // Replacing a connection must never be blocked by cleaning up the one it supersedes; a stale
      // provider session idles out on its own. Otherwise one failed cleanup wedges every retry.
      if (connection) {
        await this.provider
          .closeAll(connection.sessionId)
          .catch((error: unknown) => {
            const reason =
              error instanceof SfuProviderError ? error.message : "internal";
            this.logger.warn(
              `[calls] SFU cleanup of replaced connection failed reason=${reason}`,
            );
          });
      }
      const result = await this.provider.request("POST", "/sessions/new");
      if (!result.sessionId) throw new Error("Missing session");
      connection = {
        connectionId: request.connectionId,
        sessionId: result.sessionId,
        seatId,
        tracks: [],
      };
      state[slot] = connection;
      // Save provider identity before checking a seat that may have moved during creation.
      await this.save(call.id, userId, state);
      if (!(await this.sameSeat(userId, socketId, call.id, seatId))) {
        connection.invalid = true;
        await this.save(call.id, userId, state);
        await this.provider.closeAll(connection.sessionId);
        return failure("not_allowed", "This call is no longer available.");
      }
    } else {
      if (
        !connection ||
        connection.connectionId !== request.connectionId ||
        connection.seatId !== seatId ||
        (connection.invalid && request.action !== "close")
      ) {
        return failure("connection_expired", "Reconnect this call.");
      }
      if (request.action === "close") {
        await this.provider.closeAll(connection.sessionId);
        delete state[slot];
      } else {
        let ack: SfuAckDto;
        try {
          if (!(await this.sourceCurrent(call.id, connection)))
            throw new Error("Publisher changed");
          ack = await this.negotiate(call, connection, request);
          if (!(await this.sourceCurrent(call.id, connection)))
            throw new Error("Publisher changed");
        } catch (error) {
          connection.invalid = true;
          await this.save(call.id, userId, state);
          // A failed batch can still allocate tracks. Close the whole known provider session,
          // retaining its invalid record until confirmed cleanup so the sweep can retry.
          try {
            await this.provider.closeAll(connection.sessionId);
            delete state[slot];
            await this.save(call.id, userId, state);
          } catch {
            /* Durable-to-Redis cleanup intent remains for the sweep. */
          }
          throw error;
        }
        if (!(await this.sameSeat(userId, socketId, call.id, seatId))) {
          connection.invalid = true;
          await this.save(call.id, userId, state);
          await this.provider.closeAll(connection.sessionId);
          return failure("not_allowed", "This call is no longer available.");
        }
        await this.save(call.id, userId, state);
        if (request.action === "ready" || request.action === "unpublish")
          this.announce(call, userId, seat.sessionId!);
        return ack;
      }
    }
    await this.save(call.id, userId, state);
    return {};
  }

  private async negotiate(
    call: CallSessionRecord,
    connection: Connection,
    request: SfuRequestDto,
  ): Promise<SfuAckDto> {
    const path = `/sessions/${encodeURIComponent(connection.sessionId)}`;
    if (request.action === "ready") {
      if (request.remoteUserId || !connection.tracks.length)
        throw new Error("Invalid publication");
      connection.ready = true;
      return {};
    }
    if (request.action === "unpublish") {
      if (request.remoteUserId || !request.tracks?.length)
        throw new Error("Invalid unpublication");
      const owned = connection.tracks.filter((t) =>
        request.tracks!.some((r) => r.kind === t.kind && r.mid === t.mid),
      );
      if (owned.length !== request.tracks.length)
        throw new Error("Unknown track");
      await this.provider.close(
        connection.sessionId,
        owned.map((t) => t.mid),
      );
      connection.tracks = connection.tracks.filter((t) => !owned.includes(t));
      return {};
    }
    if (request.action === "answer") {
      if (
        !connection.awaitingAnswer ||
        request.sessionDescription?.type !== "answer"
      )
        throw new Error("Unexpected answer");
      await this.provider.request("PUT", `${path}/renegotiate`, {
        sessionDescription: request.sessionDescription,
      });
      connection.awaitingAnswer = false;
      return {};
    }
    if (connection.awaitingAnswer) throw new Error("Answer required");
    if (request.action === "publish") {
      if (
        request.remoteUserId ||
        request.sessionDescription?.type !== "offer" ||
        !request.tracks?.length
      )
        throw new Error("Invalid publication");
      if (
        new Set(request.tracks.map((t) => t.kind)).size !==
        request.tracks.length
      )
        throw new Error("Duplicate tracks");
      const added = request.tracks.filter(
        (t) => !connection.tracks.some((old) => old.kind === t.kind),
      );
      if (!added.length) throw new Error("Tracks already published");
      const result = await this.provider.request("POST", `${path}/tracks/new`, {
        sessionDescription: request.sessionDescription,
        tracks: added.map((t) => ({
          location: "local",
          mid: t.mid,
          trackName: t.kind,
        })),
      });
      if (result.sessionDescription?.type !== "answer")
        throw new Error("Missing answer");
      if (
        result.tracks?.length !== added.length ||
        added.some((t) => !result.tracks!.some((r) => r.mid === t.mid))
      ) {
        throw new Error("Incomplete publication");
      }
      connection.tracks.push(...added);
      connection.ready = false;
      return {
        sessionDescription: result.sessionDescription,
        tracks: connection.tracks,
      };
    }
    if (
      request.action !== "subscribe" ||
      !request.remoteUserId ||
      connection.tracks.length
    )
      throw new Error("Invalid subscription");
    const remote = call.participants.find(
      (p) => p.userId === request.remoteUserId,
    )!;
    const source = (
      await this.redis.getJson<Connections>(key(call.id, remote.userId))
    )?.publisher;
    if (
      !source ||
      source.seatId !== `${remote.sessionId}:${remote.joinedAt}` ||
      source.invalid ||
      !source.ready ||
      !source.tracks.length
    )
      return { tracks: [] };
    connection.source = {
      userId: remote.userId,
      connectionId: source.connectionId,
      seatId: source.seatId,
      tracks: this.trackIdentity(source),
    };
    const result = await this.provider.request("POST", `${path}/tracks/new`, {
      tracks: source.tracks.map((t) => ({
        location: "remote",
        sessionId: source.sessionId,
        trackName: t.kind,
      })),
    });
    if (
      result.sessionDescription?.type !== "offer" ||
      result.tracks?.length !== source.tracks.length
    )
      throw new Error("Missing offer");
    connection.tracks = result.tracks.map((t) => {
      const sourceTrack = source.tracks.find(
        (track) => track.kind === t.trackName,
      );
      if (!t.mid || !sourceTrack) throw new Error("Missing track identity");
      return { kind: sourceTrack.kind, mid: t.mid };
    });
    if (
      new Set(connection.tracks.map((t) => t.mid)).size !==
      connection.tracks.length
    )
      throw new Error("Duplicate mid");
    connection.awaitingAnswer = true;
    return {
      sessionDescription: result.sessionDescription,
      tracks: connection.tracks,
      revision: source.connectionId,
    };
  }

  private async sameSeat(
    userId: string,
    socketId: string,
    callId: string,
    seatId: string,
  ): Promise<boolean> {
    const current = await this.authorize(userId, socketId, callId);
    const participant = current?.participants.find((p) => p.userId === userId);
    return (
      !!participant &&
      `${participant.sessionId}:${participant.joinedAt}` === seatId
    );
  }

  private trackIdentity(connection: Connection): string {
    return JSON.stringify(connection.tracks.map((t) => [t.kind, t.mid]).sort());
  }

  private async sourceCurrent(
    callId: string,
    connection: Connection,
  ): Promise<boolean> {
    const expected = connection.source;
    if (!expected) return true;
    const call = await this.store.getByCallId(callId);
    const participant = call?.participants.find(
      (p) => p.userId === expected.userId,
    );
    if (
      !participant?.socketId ||
      !(await this.sameSeat(
        expected.userId,
        participant.socketId,
        callId,
        expected.seatId,
      ))
    )
      return false;
    const source = (
      await this.redis.getJson<Connections>(key(callId, expected.userId))
    )?.publisher;
    return (
      !!source &&
      !source.invalid &&
      !!source.ready &&
      source.connectionId === expected.connectionId &&
      source.seatId === expected.seatId &&
      this.trackIdentity(source) === expected.tracks
    );
  }

  private async save(
    callId: string,
    userId: string,
    state: Connections,
  ): Promise<void> {
    await this.redis.setJson(key(callId, userId), state, {
      ttlSeconds: 24 * 60 * 60,
    });
    await this.redis
      .raw()
      .sadd("call:sfu:live", JSON.stringify([callId, userId]));
  }

  /** Runs after seat changes and from the sweep. Never revokes a replacement seat's media. */
  async revokeStale(callId: string, userId: string): Promise<void> {
    await this.redis.withLock(
      `lock:${key(callId, userId)}`,
      { ttlMs: 30_000, waitMs: 100 },
      async () => {
        const call = await this.store.getByCallId(callId);
        const participant =
          call?.status === "ended"
            ? undefined
            : call?.participants.find((p) => p.userId === userId);
        const seatId = participant
          ? `${participant.sessionId}:${participant.joinedAt}`
          : null;
        const state =
          (await this.redis.getJson<Connections>(key(callId, userId))) ?? {};
        await Promise.all(
          Object.entries(state).map(async ([slot, connection]) => {
            const remoteGone =
              slot !== "publisher" &&
              !call?.participants.some((p) => p.userId === slot);
            if (
              connection.seatId !== seatId ||
              connection.invalid ||
              remoteGone ||
              !(await this.sourceCurrent(callId, connection))
            ) {
              try {
                await this.provider.closeAll(connection.sessionId);
                delete state[slot];
              } catch {
                /* Keep the record so the sweep retries provider failures. */
              }
            }
          }),
        );
        await this.redis.setJson(key(callId, userId), state, {
          ttlSeconds: 24 * 60 * 60,
        });
        if (!Object.keys(state).length)
          await this.redis
            .raw()
            .srem("call:sfu:live", JSON.stringify([callId, userId]));
        return true;
      },
    );
  }

  private sweeping = false;
  @Interval(15_000)
  async sweep(): Promise<void> {
    if (!this.config.runSchedulers() || this.sweeping) return;
    this.sweeping = true;
    try {
      const entries = await this.redis.raw().smembers("call:sfu:live");
      for (const entry of entries) {
        const [callId, userId] = JSON.parse(entry) as [string, string];
        await this.revokeStale(callId, userId);
      }
    } catch {
      this.logger.warn("[calls] SFU cleanup will retry");
    } finally {
      this.sweeping = false;
    }
  }

  private announce(
    call: CallSessionRecord,
    userId: string,
    seatId: string,
  ): void {
    for (const participant of call.participants) {
      if (participant.userId !== userId)
        this.realtime.emitRtcSignal(participant.userId, {
          callId: call.id,
          fromUserId: userId,
          fromSessionId: seatId,
          sfuChanged: true,
        });
    }
  }
}
