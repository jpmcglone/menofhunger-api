import { PickaxConnectionService } from "../pickax/pickax-connection.service";
import { XConnectionService } from "../x/x-connection.service";
import { sealSecret } from "../../common/crypto/secret-box";

/** A provider outage must never keep a local connection alive. */
describe.each(["pickax", "x"] as const)("%s disconnect", (platform) => {
  function harness(replaced = false) {
    const key = "synthetic-encryption-key-at-least-32-characters";
    const connection = {
      userId: "member",
      generation: "original",
      authKind: "oauth",
      refreshTokenEnc: sealSecret("synthetic-refresh-token", key),
    };
    let committed = false;
    const revoke = jest.fn(async () => {
      expect(committed).toBe(true);
      throw new Error("Provider unavailable");
    });
    const model = {
      findUnique: jest.fn(async () => connection),
      deleteMany: jest.fn(async () => ({ count: replaced ? 0 : 1 })),
    };
    const tx: any = {
      [`${platform}Connection`]: model,
      user: { update: jest.fn() },
      partnerGrant: { updateMany: jest.fn() },
    };
    const prisma: any = {
      ...tx,
      partnerClient: {
        findMany: jest.fn(async () => [{ id: "pickax-client" }]),
      },
      $transaction: jest.fn(async (fn) => {
        const result = await fn(tx);
        committed = true;
        return result;
      }),
    };
    const config: any = {
      pickaxSecretEncryptionKey: () => key,
      x: () => ({
        clientId: "fixture",
        clientSecret: "fixture",
        encryptionKey: key,
      }),
    };
    const service =
      platform === "pickax"
        ? new PickaxConnectionService(
            prisma,
            config,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            { revoke } as any,
            {} as any,
          )
        : new XConnectionService(
            prisma,
            {} as any,
            config,
            { revoke } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
          );
    jest
      .spyOn(service as any, "afterProfileChange")
      .mockResolvedValue(undefined);
    const status = {
      connected: replaced,
      username: replaced ? "newhandle" : null,
    };
    jest.spyOn(service, "getStatus").mockResolvedValue(status as any);
    return { service, tx, model, revoke, status };
  }
  it("commits disconnection before attempting best-effort provider revocation", async () => {
    const h = harness();
    await expect(h.service.disconnect("member")).resolves.toEqual(h.status);
    expect(h.model.deleteMany).toHaveBeenCalledWith({
      where: { userId: "member", generation: "original" },
    });
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.tx.user.update).toHaveBeenCalledTimes(1);
    if (platform === "pickax")
      expect(h.tx.partnerGrant.updateMany).toHaveBeenCalledTimes(1);
  });
  it("does not clear a new handle when an old-generation disconnect loses a race", async () => {
    const h = harness(true);
    await expect(h.service.disconnect("member")).resolves.toMatchObject({
      connected: true,
      username: "newhandle",
    });
    expect(h.tx.user.update).not.toHaveBeenCalled();
  });
});
