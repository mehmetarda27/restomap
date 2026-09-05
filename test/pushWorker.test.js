const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function worker(windows) {
  const events = {}, shown = [], opened = [];
  const self = {
    location: { origin: "https://restomap.com.tr" },
    addEventListener: (type, handler) => { events[type] = handler; },
    clients: { matchAll: async () => windows, openWindow: async (url) => opened.push(url) },
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../courier-push-sw.js"), "utf8"), { self, URL });
  return { events, shown, opened };
}

test("visible matching panel suppresses OS duplicate for all roles, hidden panel receives push", async () => {
  for (const role of ["courier", "restaurant", "admin"]) {
    for (const visibilityState of ["visible", "hidden"]) {
      const { events, shown } = worker([{ url: `https://restomap.com.tr/${role}.html`, visibilityState }]);
      let done;
      events.push({ data: { json: () => ({ url: `/${role}.html`, body: "Test" }) }, waitUntil: (task) => { done = task; } });
      await done;
      assert.equal(shown.length, visibilityState === "visible" ? 0 : 1);
    }
  }
});

test("notification click focuses matching role and rejects external links", async () => {
  const navigated = [];
  const { events, opened } = worker([{ url: "https://restomap.com.tr/restaurant.html", navigate: async (url) => navigated.push(url), focus: async () => {} }]);
  for (const url of ["/restaurant.html?package=one", "https://example.test/phishing"]) {
    let done;
    events.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (task) => { done = task; } });
    await done;
  }
  assert.deepEqual(navigated, ["https://restomap.com.tr/restaurant.html?package=one"]);
  assert.equal(opened.length, 0);
});
