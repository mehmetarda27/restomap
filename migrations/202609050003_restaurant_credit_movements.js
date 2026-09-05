module.exports = {
  name: "restaurant_credit_movements",
  up({ db }) {
    db.exec(`CREATE TABLE IF NOT EXISTS restaurant_credit_movements (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
      event_key TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount <> 0),
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES admins(id),
      created_at TEXT NOT NULL,
      UNIQUE (restaurant_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS idx_restaurant_credit_history ON restaurant_credit_movements (restaurant_id, created_at, id);`);
  },
};
