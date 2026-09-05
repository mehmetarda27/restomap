const test = require("node:test");
const assert = require("node:assert/strict");
const { createPushDelivery, pushPayload } = require("../services/pushDelivery");

const row = { subscription_json: JSON.stringify({ endpoint: "https://example.test" }) };
test("logout during a retry prevents another delivery attempt", async () => {
  let active = true, attempts = 0;
  const deliver = createPushDelivery({
    active: () => active,
    send: async () => { attempts++; throw { statusCode: 503 }; },
    success() {}, failure() {}, invalid() {}, wait: async () => { active = false; },
  });
  assert.equal(await deliver(row, {}), false);
  assert.equal(attempts, 1);
});
test("recipient selection never turns generic broadcasts into cross-role pushes", () => {
  const { recipients } = require("../services/pushDelivery");
  assert.deepEqual(recipients("courier", { restaurantId: "r1", broadcast: true }), []);
  assert.deepEqual(recipients("restaurant", { courierId: "c1", targetRole: "all" }), []);
  assert.deepEqual(recipients("courier", { courierId: "c1", audiences: [{ role: "restaurant", id: "r1" }] }), ["c1"]);
  assert.equal(recipients("restaurant", { announcementId: "a1", targetRole: "restaurant" }), null);
  assert.deepEqual(recipients("courier", { announcementId: "a1", targetRole: "restaurant" }), []);
});
test("transient push failure retries and success records recovery", async () => {
  let attempts = 0, successes = 0, failures = 0;
  const deliver = createPushDelivery({
    send: async (_, __, options) => { assert.equal(options.timeout, 10000); if (++attempts < 3) throw Object.assign(new Error("offline"), { statusCode: 503 }); },
    success: () => successes++, failure: () => failures++, invalid: () => assert.fail("valid device removed"), wait: async () => {},
  });
  assert.equal(await deliver(row, {}), true);
  assert.equal(attempts, 3); assert.equal(successes, 1); assert.equal(failures, 2);
});
test("expired subscriptions are removed without retry; permanent errors stop", async () => {
  for (const statusCode of [404, 410, 400, 403]) {
    let attempts = 0, removed = 0;
    const deliver = createPushDelivery({ send: async () => { attempts++; throw { statusCode }; }, success: () => assert.fail(), failure: () => {}, invalid: () => removed++, wait: async () => assert.fail() });
    assert.equal(await deliver(row, {}), false);
    assert.equal(attempts, 1); assert.equal(removed, [404, 410].includes(statusCode) ? 1 : 0);
  }
});
test("distinct package events retain distinct tags and role deep links", () => {
  for (const role of ["admin", "restaurant", "courier"]) {
    const first = pushPayload(role, { type: "package-assigned", packageId: "x&y", message: "Atandı" });
    const second = pushPayload(role, { type: "package-status", packageId: "x&y", message: "İptal edildi" });
    assert.notEqual(first.tag, second.tag);
    assert.equal(new URL(first.url, "https://restomap.com.tr").pathname, `/${role}.html`);
    assert.equal(new URL(first.url, "https://restomap.com.tr").searchParams.get("package"), "x&y");
  }
});
