module.exports = {
  name: "notification_read_state",
  up({ db, helpers }) {
    helpers.addColumnIfMissing(db, "notification_logs", "read_at", "TEXT");
  },
};
