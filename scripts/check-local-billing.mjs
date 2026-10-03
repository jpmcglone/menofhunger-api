import assert from "node:assert/strict";
const base = "http://127.0.0.1:3002/v1";
const login = await fetch(base + "/auth/phone/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ phone: "+15550000991", code: "000000" }),
});
assert.equal(login.status, 201, "local fixture login");
const cookies = login.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
assert.ok(cookies);
async function request(path, body) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { cookie: cookies, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(r.ok, `${path}: ${r.status}`);
  return (await r.json()).data;
}
const before = await request("/billing/me");
assert.equal(before.verified, true);
assert.equal(before.premium, false);
assert.equal((await request("/auth/me")).premium, false);
const snapshot = {
  entitlements: [
    {
      productId: "com.menofhunger.premium.monthly",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
  ],
};
const active = await request("/billing/local-test/sync", snapshot);
assert.equal(active.premium, true);
assert.equal(active.source, "grant");
assert.equal(
  (await request("/auth/me")).premium,
  true,
  "session cache reflects activation immediately",
);
const restore = await request("/billing/local-test/sync", snapshot);
assert.equal(restore.premium, true);
const expired = await request("/billing/local-test/sync", { entitlements: [] });
assert.equal(expired.premium, false);
assert.equal(
  (await request("/auth/me")).premium,
  false,
  "session cache reflects expiry immediately",
);
console.log(
  "PASS live local API: verified/free → simulated Premium grant → idempotent restore → expired/free. Fixture reset.",
);
