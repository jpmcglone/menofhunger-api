import { SfuService } from "./sfu.service";

function harness() {
  let call: any = {
    id: "call-1",
    conversationId: "conv-1",
    mediaTransport: "sfu",
    status: "active",
    participants: [
      {
        userId: "alice",
        socketId: "socket-a",
        sessionId: "seat-a",
        joinedAt: "today",
      },
      {
        userId: "bob",
        socketId: "socket-b",
        sessionId: "seat-b",
        joinedAt: "today",
      },
    ],
  };
  const data = new Map<string, any>();
  const raw = {
    sadd: jest.fn(),
    srem: jest.fn(),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn(),
  };
  const redis = {
    getJson: jest.fn(async (key: string) =>
      structuredClone(data.get(key) ?? null),
    ),
    setJson: jest.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    }),
    withLock: jest.fn(
      async (_key: string, _opts: unknown, run: () => Promise<unknown>) =>
        run(),
    ),
    raw: () => raw,
  };
  let sequence = 0;
  const provider = {
    enabled: () => true,
    closeAll: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    request: jest.fn(
      async (_method: string, path: string, body?: any): Promise<any> => {
        if (path === "/sessions/new")
          return { sessionId: `provider-${++sequence}` };
        if (path.endsWith("/renegotiate")) return {};
        return {
          sessionDescription: {
            type: body.sessionDescription ? "answer" : "offer",
            sdp: "provider-sdp",
          },
          tracks: body.tracks.map((t: any, i: number) => ({
            mid: t.mid ?? `${i}`,
            trackName: t.trackName,
          })),
        };
      },
    ),
  };
  const messages = {
    getCallConversationContext: jest.fn(async () => ({
      participants: ["alice", "bob"].map((userId) => ({
        userId,
        status: "accepted",
        banned: false,
      })),
    })),
  };
  const realtime = { emitRtcSignal: jest.fn() };
  const service = new SfuService(
    provider as never,
    { getByCallId: async () => structuredClone(call) } as never,
    redis as never,
    messages as never,
    realtime as never,
    { runSchedulers: () => true } as never,
    { allowsAllocation: async () => true } as never,
  );
  const send = (
    action: string,
    fields: any = {},
    user = "alice",
    socket = "socket-a",
  ) =>
    service.handle(user, socket, {
      callId: "call-1",
      connectionId: "connection-1",
      action,
      ...fields,
    });
  const publish = async () => {
    await send("open");
    await send("publish", {
      sessionDescription: { type: "offer", sdp: "offer" },
      tracks: [{ kind: "audio", mid: "0" }],
    });
    return send("ready");
  };
  return {
    service,
    send,
    publish,
    provider,
    redis,
    realtime,
    data,
    messages,
    raw,
    get call() {
      return call;
    },
    end: () => {
      call = null;
    },
  };
}

describe("SFU authorization and negotiation", () => {
  it("rejects a displaced socket before touching Cloudflare", async () => {
    const h = harness();
    expect((await h.send("open", {}, "alice", "old-socket")).error?.code).toBe(
      "not_allowed",
    );
    expect(h.provider.request).not.toHaveBeenCalled();
  });
  it("rejects arbitrary provider session ids and oversized offers", async () => {
    const h = harness();
    expect((await h.send("open", { sessionId: "victim" })).error?.code).toBe(
      "invalid_payload",
    );
    expect(
      (
        await h.send("publish", {
          sessionDescription: { type: "offer", sdp: "x".repeat(200001) },
        })
      ).error?.code,
    ).toBe("invalid_payload");
  });
  it("does not allow a conversation outsider to subscribe", async () => {
    const h = harness();
    expect(
      (await h.send("open", { remoteUserId: "outsider" })).error?.code,
    ).toBe("not_allowed");
    expect(h.provider.request).not.toHaveBeenCalled();
  });
  it("deduplicates an open and announces only a completed publication", async () => {
    const h = harness();
    await h.send("open");
    await h.send("open");
    expect(h.provider.request).toHaveBeenCalledTimes(1);
    await h.publish();
    expect(h.realtime.emitRtcSignal).toHaveBeenCalledWith(
      "bob",
      expect.objectContaining({ sfuChanged: true, fromUserId: "alice" }),
    );
  });
  it("resolves the publisher on the server and requires the subscription answer", async () => {
    const h = harness();
    await h.publish();
    await h.send("open", { remoteUserId: "alice" }, "bob", "socket-b");
    const ack = await h.send(
      "subscribe",
      { remoteUserId: "alice" },
      "bob",
      "socket-b",
    );
    expect(ack.tracks).toEqual([{ kind: "audio", mid: "0" }]);
    expect(h.provider.request).toHaveBeenLastCalledWith(
      "POST",
      "/sessions/provider-2/tracks/new",
      {
        tracks: [
          { location: "remote", sessionId: "provider-1", trackName: "audio" },
        ],
      },
    );
    expect(
      (
        await h.send(
          "answer",
          {
            remoteUserId: "alice",
            sessionDescription: { type: "answer", sdp: "answer" },
          },
          "bob",
          "socket-b",
        )
      ).error,
    ).toBeUndefined();
  });
  it("opens a replacement receiver even when cleaning up the superseded session fails", async () => {
    const h = harness();
    await h.send("open", { remoteUserId: "alice" }, "bob", "socket-b");
    h.provider.closeAll.mockRejectedValueOnce(new Error("410"));
    const ack = await h.service.handle("bob", "socket-b", {
      callId: "call-1",
      connectionId: "connection-2",
      action: "open",
      remoteUserId: "alice",
    });
    expect(ack.error).toBeUndefined();
    expect(h.provider.request).toHaveBeenLastCalledWith(
      "POST",
      "/sessions/new",
    );
  });
  it("invalidates uncertain negotiations and never announces them", async () => {
    const h = harness();
    await h.send("open");
    h.provider.request.mockRejectedValueOnce(
      new Error("partial provider failure"),
    );
    expect(
      (
        await h.send("publish", {
          sessionDescription: { type: "offer", sdp: "offer" },
          tracks: [{ kind: "audio", mid: "0" }],
        })
      ).error,
    ).toBeDefined();
    expect(h.realtime.emitRtcSignal).not.toHaveBeenCalled();
    await h.service.revokeStale("call-1", "alice");
    expect(h.provider.closeAll).toHaveBeenCalledWith("provider-1");
  });
  it("force-closes departed seats but preserves the current seat", async () => {
    const h = harness();
    await h.publish();
    await h.service.revokeStale("call-1", "alice");
    expect(h.provider.closeAll).not.toHaveBeenCalled();
    h.call.participants[0].sessionId = "new-device";
    await h.service.revokeStale("call-1", "alice");
    expect(h.provider.closeAll).toHaveBeenCalledWith("provider-1");
  });
  it("retries failed cleanup after the call has ended", async () => {
    const h = harness();
    await h.publish();
    h.end();
    h.provider.closeAll.mockRejectedValueOnce(new Error("offline"));
    await h.service.revokeStale("call-1", "alice");
    expect(h.raw.srem).not.toHaveBeenCalled();
    await h.service.revokeStale("call-1", "alice");
    expect(h.raw.srem).toHaveBeenCalled();
  });
  it("removes paused tracks from discovery and allows republishing their kind", async () => {
    const h = harness();
    await h.publish();
    expect(
      (await h.send("unpublish", { tracks: [{ kind: "audio", mid: "0" }] }))
        .error,
    ).toBeUndefined();
    expect(h.provider.close).toHaveBeenCalledWith("provider-1", ["0"]);
    expect(h.data.get("call:sfu:call-1:alice").publisher.tracks).toEqual([]);
    expect((await h.publish()).error).toBeUndefined();
  });
  it("retains cleanup state when a seat leaves during provider session creation", async () => {
    const h = harness();
    h.provider.request.mockImplementationOnce(async () => {
      h.end();
      return { sessionId: "orphan-session" };
    });
    h.provider.closeAll.mockRejectedValueOnce(new Error("temporary outage"));
    expect((await h.send("open")).error).toBeDefined();
    expect(h.data.get("call:sfu:call-1:alice").publisher.invalid).toBe(true);
    await h.service.revokeStale("call-1", "alice");
    expect(h.provider.closeAll).toHaveBeenLastCalledWith("orphan-session");
    expect(h.data.get("call:sfu:call-1:alice")).toEqual({});
  });
  it("rejects a subscription whose publisher moves during provider negotiation", async () => {
    const h = harness();
    await h.publish();
    await h.send("open", { remoteUserId: "alice" }, "bob", "socket-b");
    h.provider.request.mockImplementationOnce(async () => {
      h.call.participants[0].sessionId = "replacement-seat";
      return {
        sessionDescription: { type: "offer", sdp: "offer" },
        tracks: [{ mid: "0", trackName: "audio" }],
      };
    });
    expect(
      (await h.send("subscribe", { remoteUserId: "alice" }, "bob", "socket-b"))
        .error,
    ).toBeDefined();
    await h.service.revokeStale("call-1", "bob");
    expect(h.provider.closeAll).toHaveBeenCalledWith("provider-2");
  });
  it("rejects an answer when the publication was replaced after the offer", async () => {
    const h = harness();
    await h.publish();
    await h.send("open", { remoteUserId: "alice" }, "bob", "socket-b");
    await h.send("subscribe", { remoteUserId: "alice" }, "bob", "socket-b");
    h.data.get("call:sfu:call-1:alice").publisher.connectionId =
      "new-publication";
    h.provider.request.mockClear();
    expect(
      (
        await h.send(
          "answer",
          {
            remoteUserId: "alice",
            sessionDescription: { type: "answer", sdp: "answer" },
          },
          "bob",
          "socket-b",
        )
      ).error,
    ).toBeDefined();
    expect(h.provider.request).not.toHaveBeenCalled();
  });
  it("cleans up ended records even when their participant list is retained", async () => {
    const h = harness();
    await h.publish();
    h.call.status = "ended";
    await h.service.revokeStale("call-1", "alice");
    expect(h.provider.closeAll).toHaveBeenCalledWith("provider-1");
    expect(h.data.get("call:sfu:call-1:alice")).toEqual({});
  });
  it("fails closed when the distributed negotiation lock is busy", async () => {
    const h = harness();
    h.redis.withLock.mockResolvedValueOnce(null);
    expect((await h.send("open")).error?.code).toBe("busy");
    expect(h.provider.request).not.toHaveBeenCalled();
  });
});
