"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { assertMinor, sumMinor } = require("./financeMoney");

const ACCOUNTS = new Set(["cash", "bank", "restaurant_receivable", "courier_payable", "delivery_revenue", "commission_revenue", "courier_expense", "adjustment_expense"]);

function required(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`Invalid ${field}`);
  return value.trim();
}

function identifier(value) {
  return value == null ? null : required(value, "identifier");
}

function normalize(input) {
  if (!input || input.currency !== "TRY") throw new TypeError("Currency must be TRY");
  if (!Array.isArray(input.lines) || input.lines.length < 2 || input.lines.length > 100) throw new TypeError("Journal requires 2..100 lines");
  const lines = input.lines.map((line) => {
    if (!ACCOUNTS.has(line.accountCode)) throw new TypeError("Unknown account code");
    const amountMinor = assertMinor(line.amountMinor);
    if (!amountMinor) throw new TypeError("Zero posting is not allowed");
    const courierId = identifier(line.courierId);
    const restaurantId = identifier(line.restaurantId);
    if (line.accountCode === "courier_payable" && !courierId) throw new TypeError("Courier payable requires courier");
    if (line.accountCode === "restaurant_receivable" && !restaurantId) throw new TypeError("Restaurant receivable requires restaurant");
    return { accountCode: line.accountCode, amountMinor, courierId, restaurantId, packageId: identifier(line.packageId) };
  });
  if (sumMinor(lines.map((line) => line.amountMinor)) !== 0) throw new TypeError("Journal must balance");
  if (typeof input.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.occurredAt)
      || !Number.isFinite(Date.parse(input.occurredAt)) || new Date(input.occurredAt).toISOString() !== input.occurredAt) {
    throw new TypeError("occurredAt must be a canonical UTC timestamp");
  }
  return {
    eventKey: required(input.eventKey, "event key"), eventType: required(input.eventType, "event type"),
    currency: "TRY", occurredAt: input.occurredAt, createdByAdminId: identifier(input.createdByAdminId),
    reason: required(input.reason, "reason", 2000), reversalOf: identifier(input.reversalOf), lines,
  };
}

// Internal service, not a public endpoint. The caller must obtain actor/subject
// from the authenticated session. transaction follows the existing DB adapter.
function createFinancialJournalService({ db, transaction, now = () => new Date().toISOString() }) {
  if (!db || typeof transaction !== "function") throw new TypeError("Database and transaction are required");

  function read(id, connection = db) {
    const journal = connection.prepare("SELECT * FROM financial_journals WHERE id = ?").get(id);
    if (!journal) return null;
    return { ...journal, lines: connection.prepare("SELECT * FROM financial_entries WHERE journal_id = ? ORDER BY line_number").all(id) };
  }

  function postInside(connection, normalized) {
    const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const id = randomUUID();
    // ON CONFLICT also serializes duplicate concurrent submissions on PostgreSQL.
    connection.prepare(`INSERT INTO financial_journals
      (id, event_key, event_type, fingerprint, currency, occurred_at, created_at, created_by_admin_id, reason, reversal_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_key) DO NOTHING`)
      .run(id, normalized.eventKey, normalized.eventType, fingerprint, "TRY", normalized.occurredAt, now(), normalized.createdByAdminId, normalized.reason, normalized.reversalOf);
    const stored = connection.prepare("SELECT * FROM financial_journals WHERE event_key = ?").get(normalized.eventKey);
    if (stored.fingerprint !== fingerprint) {
      const error = new Error("Event key already used with different financial data");
      error.statusCode = 409;
      throw error;
    }
    if (stored.id === id) {
      normalized.lines.forEach((line, index) => {
        connection.prepare(`INSERT INTO financial_entries
          (id, journal_id, line_number, account_code, amount_minor, courier_id, restaurant_id, package_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), id, index, line.accountCode, line.amountMinor, line.courierId, line.restaurantId, line.packageId);
      });
    }
    return read(stored.id, connection);
  }

  function post(input) {
    if (input?.reversalOf != null) throw new TypeError("Use reverse for reversals");
    const normalized = normalize(input);
    return transaction((connection) => postInside(connection, normalized));
  }

  function reverse(id, { eventKey, occurredAt, createdByAdminId, reason }) {
    return transaction((connection) => {
      const original = read(id, connection);
      if (!original) throw new Error("Journal not found");
      if (original.reversal_of) throw new Error("Cannot reverse a reversal");
      const normalized = normalize({ eventKey, eventType: "journal.reversed", currency: original.currency,
        occurredAt, createdByAdminId, reason, reversalOf: original.id,
        lines: original.lines.map((line) => ({ accountCode: line.account_code, amountMinor: -Number(line.amount_minor),
          courierId: line.courier_id, restaurantId: line.restaurant_id, packageId: line.package_id })) });
      return postInside(connection, normalized);
    });
  }

  return { post, reverse, read };
}

module.exports = { createFinancialJournalService };
