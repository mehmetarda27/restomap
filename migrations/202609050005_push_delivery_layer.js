module.exports = {
  name: "push_delivery_layer",
  up({ db, helpers }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
        id TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        subscription_json TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'web',
        device_label TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (admin_id) REFERENCES admins(id)
      );
      CREATE INDEX IF NOT EXISTS idx_admin_push_subscriptions_admin
      ON admin_push_subscriptions (admin_id, updated_at DESC);
    `);

    for (const table of ["courier_push_subscriptions", "restaurant_push_subscriptions"]) {
      helpers.addColumnIfMissing(db, table, "platform", "TEXT NOT NULL DEFAULT 'web'");
      helpers.addColumnIfMissing(db, table, "device_label", "TEXT");
      helpers.addColumnIfMissing(db, table, "last_success_at", "TEXT");
      helpers.addColumnIfMissing(db, table, "last_failure_at", "TEXT");
      helpers.addColumnIfMissing(db, table, "failure_count", "INTEGER NOT NULL DEFAULT 0");
      helpers.addColumnIfMissing(db, table, "last_error", "TEXT");
    }
  },
};
