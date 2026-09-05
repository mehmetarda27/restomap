"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const migration = require("../migrations/202609050001_financial_journal");
const { createFinancialJournalService } = require("../services/financialJournalService");
const { toMinor, fromMinor, sumMinor, percentageMinor } = require("../services/financeMoney");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE admins (id TEXT PRIMARY KEY);
    CREATE TABLE couriers (id TEXT PRIMARY KEY);
    CREATE TABLE restaurants (id TEXT PRIMARY KEY);
    CREATE TABLE packages (id TEXT PRIMARY KEY);
    INSERT INTO admins VALUES ('admin');
    INSERT INTO couriers VALUES ('courier');
    INSERT INTO restaurants VALUES ('restaurant');
    INSERT INTO packages VALUES ('package');`);
  migration.up({ db });
  const transaction = (callback) => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = callback(db); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return { db, service: createFinancialJournalService({ db, transaction }) };
}

function collection(overrides = {}) {
  return { eventKey: "collection:1", eventType: "restaurant.collection", currency: "TRY",
    occurredAt: "2026-09-05T10:00:00.000Z", createdByAdminId: "admin", reason: "Test collection",
    lines: [{ accountCode: "bank", amountMinor: 500000 },
      { accountCode: "restaurant_receivable", restaurantId: "restaurant", amountMinor: -500000 }], ...overrides };
}

test("money preserves decimal precision and signed penalties", () => {
  assert.equal(sumMinor([toMinor("0.10"), toMinor("0.20")]), 30);
  assert.equal(toMinor("-500.00"), -50000);
  assert.equal(fromMinor(-50000), "-500.00");
  assert.equal(fromMinor(1), "0.01");
  assert.equal(sumMinor([toMinor("7560"), toMinor("750"), toMinor("-500")]), 781000);
});

test("money rejects ambiguous, nonfinite and imprecise input", () => {
  for (const value of [0.1, NaN, Infinity, "1,50", "1e2", "", "0.001", "12 TL", "90071992547410.00"]) {
    assert.throws(() => toMinor(value));
  }
  assert.throws(() => sumMinor([Number.MAX_SAFE_INTEGER, 1]));
  assert.throws(() => fromMinor(0.1));
});

test("percentage rounds exact half cents away from zero", () => {
  assert.equal(percentageMinor(10000, 500), 500);
  assert.equal(percentageMinor(1, 5000), 1);
  assert.equal(percentageMinor(-1, 5000), -1);
  assert.throws(() => percentageMinor(100, 10001));
});

test("journal stores balanced collection with subject relation", (t) => {
  const { db, service } = fixture(t);
  const journal = service.post(collection());
  assert.equal(journal.lines.length, 2);
  assert.equal(journal.created_by_admin_id, "admin");
  assert.equal(db.prepare("SELECT SUM(amount_minor) AS total FROM financial_entries").get().total, 0);
  assert.equal(journal.lines[1].restaurant_id, "restaurant");
});

test("repeated business event does not duplicate financial movement", (t) => {
  const { db, service } = fixture(t);
  const first = service.post(collection());
  assert.equal(service.post(collection()).id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_entries").get().count, 2);
});

test("same event key with changed data rejects and preserves original", (t) => {
  const { db, service } = fixture(t);
  service.post(collection());
  assert.throws(() => service.post(collection({ reason: "Different command" })), { statusCode: 409 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_journals").get().count, 1);
});

test("foreign key failure rolls back journal and every line", (t) => {
  const { db, service } = fixture(t);
  const input = collection();
  input.lines[1].restaurantId = "missing";
  assert.throws(() => service.post(input));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_journals").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_entries").get().count, 0);
});

test("unbalanced and missing-subject commands are rejected before writing", (t) => {
  const { db, service } = fixture(t);
  const input = collection();
  input.lines[0].amountMinor = 1;
  assert.throws(() => service.post(input), /balance/);
  input.lines[0].amountMinor = 500000;
  delete input.lines[1].restaurantId;
  assert.throws(() => service.post(input), /requires restaurant/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_journals").get().count, 0);
});

test("reversal appends opposite entries without editing original", (t) => {
  const { db, service } = fixture(t);
  const original = service.post(collection());
  const command = { eventKey: "reverse:1", occurredAt: "2026-09-05T11:00:00.000Z", createdByAdminId: "admin", reason: "Correction" };
  const reversed = service.reverse(original.id, command);
  assert.equal(reversed.reversal_of, original.id);
  assert.equal(service.reverse(original.id, command).id, reversed.id);
  assert.deepEqual(service.read(original.id), original);
  assert.equal(db.prepare("SELECT SUM(amount_minor) AS total FROM financial_entries WHERE account_code = 'bank'").get().total, 0);
  assert.throws(() => service.reverse(original.id, { ...command, eventKey: "reverse:2" }));
  assert.throws(() => service.reverse(reversed.id, { ...command, eventKey: "reverse:3" }));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM financial_journals").get().count, 2);
});

test("rejects forged reversal, unsupported currency and invalid date", (t) => {
  const { service } = fixture(t);
  assert.throws(() => service.post(collection({ reversalOf: "forged" })), /Use reverse/);
  assert.throws(() => service.post(collection({ currency: "USD" })), /Currency/);
  assert.throws(() => service.post(collection({ occurredAt: "2026-02-30T10:00:00.000Z" })), /timestamp/);
});

test("migration can run again without replacing existing financial records", (t) => {
  const { db, service } = fixture(t);
  const original = service.post(collection());
  migration.up({ db });
  assert.deepEqual(service.read(original.id), original);
});
