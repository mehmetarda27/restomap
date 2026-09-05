module.exports = {
  name: "earning_manual_components",
  up({ db, helpers }) {
    helpers.addColumnIfMissing(db, "courier_earnings", "manual_bonus_amount", "REAL");
    helpers.addColumnIfMissing(db, "courier_earnings", "manual_deduction_amount", "REAL");
  },
};
