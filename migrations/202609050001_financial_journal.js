"use strict";

// Additive foundation only. Existing earnings/settlements remain the source of
// their workflows; no guessed opening balances or historical repricing.
module.exports = {
  name: "financial_journal",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS financial_journals (
        id TEXT PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'TRY'),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by_admin_id TEXT REFERENCES admins(id),
        reason TEXT NOT NULL,
        reversal_of TEXT UNIQUE REFERENCES financial_journals(id)
      );
      CREATE TABLE IF NOT EXISTS financial_entries (
        id TEXT PRIMARY KEY,
        journal_id TEXT NOT NULL REFERENCES financial_journals(id),
        line_number INTEGER NOT NULL,
        account_code TEXT NOT NULL CHECK (account_code IN (
          'cash', 'bank', 'restaurant_receivable', 'courier_payable',
          'delivery_revenue', 'commission_revenue', 'courier_expense', 'adjustment_expense'
        )),
        amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0 AND amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
        courier_id TEXT REFERENCES couriers(id),
        restaurant_id TEXT REFERENCES restaurants(id),
        package_id TEXT REFERENCES packages(id),
        UNIQUE (journal_id, line_number)
      );
      CREATE INDEX IF NOT EXISTS idx_financial_journals_occurred ON financial_journals (occurred_at, id);
      CREATE INDEX IF NOT EXISTS idx_financial_entries_restaurant ON financial_entries (restaurant_id, journal_id);
      CREATE INDEX IF NOT EXISTS idx_financial_entries_courier ON financial_entries (courier_id, journal_id);
      CREATE INDEX IF NOT EXISTS idx_financial_entries_package ON financial_entries (package_id, journal_id);
    `);
  },
};
