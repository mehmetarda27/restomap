const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const match = source.match(/function streamMatchesAudience\(stream, event\) \{[\s\S]*?\n\}/);
assert.ok(match, "streamMatchesAudience function should exist");
const streamMatchesAudience = Function(`${match[0]}; return streamMatchesAudience;`)();

test("live events are delivered only to the targeted non-admin audience", () => {
  const admin = { audience: { role: "admin" } };
  const restaurantA = { audience: { role: "restaurant", restaurantId: "rst_a" } };
  const restaurantB = { audience: { role: "restaurant", restaurantId: "rst_b" } };
  const courierA = { audience: { role: "courier", courierId: "cr_a" } };
  const courierB = { audience: { role: "courier", courierId: "cr_b" } };

  assert.equal(streamMatchesAudience(admin, { type: "workspace-update", courierId: "cr_a" }), true);
  assert.equal(streamMatchesAudience(courierA, { type: "workspace-update", courierId: "cr_a" }), true);
  assert.equal(streamMatchesAudience(courierB, { type: "workspace-update", courierId: "cr_a" }), false);
  assert.equal(streamMatchesAudience(restaurantA, { type: "workspace-update", courierId: "cr_a" }), false);

  assert.equal(streamMatchesAudience(restaurantA, { type: "package-created", restaurantId: "rst_a", courierId: "cr_a" }), true);
  assert.equal(streamMatchesAudience(courierA, { type: "package-created", restaurantId: "rst_a", courierId: "cr_a" }), true);
  assert.equal(streamMatchesAudience(restaurantB, { type: "package-created", restaurantId: "rst_a", courierId: "cr_a" }), false);
  assert.equal(streamMatchesAudience(courierB, { type: "package-created", restaurantId: "rst_a", courierId: "cr_a" }), false);

  assert.equal(streamMatchesAudience(restaurantA, { type: "system-settings-update" }), false);
  assert.equal(streamMatchesAudience(courierA, { type: "system-settings-update" }), false);
  assert.equal(streamMatchesAudience(courierB, { type: "global", broadcast: true }), true);
});
