"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { DatabaseSync } = require("node:sqlite");

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const [key, ...value] = entry.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));

const targetPath = path.resolve(args.target || process.env.DB_PATH || "restomap.sqlite");
const pruneRequested = /^(?:1|true|yes)$/i.test(String(args.prune || ""));
const sourceUrl = args["source-file"]
  ? fs.readFileSync(path.resolve(args["source-file"]), "utf8").trim()
  : String(process.env.DATABASE_URL || "").trim();

if (!/^postgres(?:ql)?:\/\//i.test(sourceUrl)) {
  throw new Error("A PostgreSQL connection is required through --source-file or DATABASE_URL.");
}
if (!fs.existsSync(targetPath)) throw new Error(`SQLite target not found: ${targetPath}`);

// Authentication, browser push and throttling state are intentionally local to each deployment.
const excludedTables = new Set([
  "admin_sessions",
  "admins",
  "courier_push_subscriptions",
  "courier_sessions",
  "password_reset_tokens",
  "rate_limit_buckets",
  "refresh_tokens",
  "restaurant_push_subscriptions",
  "restaurant_sessions",
  "schema_migrations",
  "token_revocations",
]);

// Older SQLite schemas do not declare every logical relationship as a foreign
// key. Keep those references aligned when natural identities (for example the
// same courier username) use different technical ids in PostgreSQL and SQLite.
const implicitIdentityReferences = {
  audit_logs: { restaurant_id: "restaurants" },
  courier_daily_reports: { courier_id: "couriers" },
  courier_earning_items: { restaurant_id: "restaurants" },
  courier_earnings: { courier_id: "couriers" },
  customers: { restaurant_id: "restaurants" },
  packages: { assigned_courier_id: "couriers" },
  platform_events: { restaurant_id: "restaurants" },
  restaurant_settlements: { restaurant_id: "restaurants" },
  webhook_logs: { restaurant_id: "restaurants" },
};

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const normalize = (value) => {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
};
const keyOf = (row, columns) => JSON.stringify(columns.map((column) => normalize(row[column])));

async function buildIdentityMap(source, target, table, naturalColumns, dependencyMaps = {}) {
  const map = new Map();
  const columns = ["id", ...naturalColumns];
  const sourceRows = (await source.query(
    `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`
  )).rows;
  const targetRows = target.prepare(
    `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`
  ).all();
  const normalizedKey = (row) => {
    const values = naturalColumns.map((column) => {
      const raw = normalize(row[column]);
      const dependency = dependencyMaps[column];
      return dependency && dependency.has(String(raw)) ? dependency.get(String(raw)) : raw;
    });
    if (values.some((value) => value == null || value === "")) return null;
    return JSON.stringify(values);
  };
  const targets = new Map(targetRows.map((row) => [normalizedKey(row), String(row.id)]).filter(([key]) => key));
  for (const row of sourceRows) {
    const key = normalizedKey(row);
    const targetId = key ? targets.get(key) : null;
    if (targetId && targetId !== String(row.id)) map.set(String(row.id), targetId);
  }
  return map;
}

async function main() {
  const source = new Client({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false } });
  const target = new DatabaseSync(targetPath);
  const summary = {
    source: "postgresql",
    target: targetPath,
    mode: pruneRequested ? "mirror" : "merge",
    imported: {},
    skipped: [],
  };

  try {
    await source.connect();
    target.exec("PRAGMA foreign_keys = OFF");

    const sourceTables = new Set((await source.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `)).rows.map((row) => row.table_name));
    const targetTables = new Set(target.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((row) => row.name));

    const tables = [...sourceTables]
      .filter((table) => targetTables.has(table) && !excludedTables.has(table))
      .sort();

    const identityMaps = new Map();
    identityMaps.set("restaurants", await buildIdentityMap(source, target, "restaurants", ["username"]));
    identityMaps.set("couriers", await buildIdentityMap(source, target, "couriers", ["username"]));
    identityMaps.set("customers", await buildIdentityMap(source, target, "customers", ["restaurant_id", "phone"], {
      restaurant_id: identityMaps.get("restaurants"),
    }));
    identityMaps.set("packages", await buildIdentityMap(source, target, "packages", ["tracking_no"]));
    identityMaps.set("platform_orders", await buildIdentityMap(
      source,
      target,
      "platform_orders",
      ["platform", "platform_order_id", "restaurant_id"],
      { restaurant_id: identityMaps.get("restaurants") }
    ));
    summary.identityRemaps = Object.fromEntries(
      [...identityMaps].map(([table, map]) => [table, map.size])
    );

    target.exec("BEGIN IMMEDIATE");
    try {
      for (const table of tables) {
        const sqliteInfo = target.prepare(`PRAGMA table_info(${quote(table)})`).all();
        const sqliteColumns = new Set(sqliteInfo.map((column) => column.name));
        const primaryKey = sqliteInfo.filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk).map((column) => column.name);
        const postgresColumns = (await source.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `, [table])).rows.map((row) => row.column_name);
        const columns = postgresColumns.filter((column) => sqliteColumns.has(column));

        if (!columns.length || !primaryKey.length || primaryKey.some((column) => !columns.includes(column))) {
          summary.skipped.push({ table, reason: "missing_common_columns_or_primary_key" });
          continue;
        }

        const rows = (await source.query(
          `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`
        )).rows;
        const foreignKeys = target.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all();
        const remappedRows = rows.map((sourceRow) => {
          const row = { ...sourceRow };
          const ownMap = identityMaps.get(table);
          if (ownMap && row.id != null && ownMap.has(String(row.id))) row.id = ownMap.get(String(row.id));
          for (const foreignKey of foreignKeys) {
            const dependency = identityMaps.get(foreignKey.table);
            if (dependency && row[foreignKey.from] != null && dependency.has(String(row[foreignKey.from]))) {
              row[foreignKey.from] = dependency.get(String(row[foreignKey.from]));
            }
          }
          for (const [column, dependencyTable] of Object.entries(implicitIdentityReferences[table] || {})) {
            const dependency = identityMaps.get(dependencyTable);
            if (dependency && row[column] != null && dependency.has(String(row[column]))) {
              row[column] = dependency.get(String(row[column]));
            }
          }
          return row;
        });
        const existingRows = target.prepare(
          `SELECT ${primaryKey.map(quote).join(", ")} FROM ${quote(table)}`
        ).all();
        const existing = new Set(existingRows.map((row) => keyOf(row, primaryKey)));
        const updateColumns = columns.filter((column) => !primaryKey.includes(column));
        const conflict = updateColumns.length
          ? `DO UPDATE SET ${updateColumns.map((column) => `${quote(column)} = excluded.${quote(column)}`).join(", ")}`
          : "DO NOTHING";
        const statement = target.prepare(`
          INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")})
          VALUES (${columns.map(() => "?").join(", ")})
          ON CONFLICT (${primaryKey.map(quote).join(", ")}) ${conflict}
        `);
        let inserted = 0;
        let updated = 0;
        for (const row of remappedRows) {
          const key = keyOf(row, primaryKey);
          if (existing.has(key)) updated += 1;
          else {
            inserted += 1;
            existing.add(key);
          }
          statement.run(...columns.map((column) => normalize(row[column])));
        }
        let deleted = 0;
        if (pruneRequested) {
          const sourceKeys = new Set(remappedRows.map((row) => keyOf(row, primaryKey)));
          const deleteStatement = target.prepare(
            `DELETE FROM ${quote(table)} WHERE ${primaryKey.map((column) => `${quote(column)} = ?`).join(" AND ")}`
          );
          for (const row of existingRows) {
            if (sourceKeys.has(keyOf(row, primaryKey))) continue;
            deleteStatement.run(...primaryKey.map((column) => normalize(row[column])));
            deleted += 1;
          }
        }
        summary.imported[table] = { sourceRows: rows.length, inserted, updated, deleted };
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }

    target.exec("PRAGMA foreign_keys = ON");
    const violations = target.prepare("PRAGMA foreign_key_check").all();
    summary.foreignKeyViolations = violations.length;
    if (violations.length) summary.violationSample = violations.slice(0, 10);
    console.log(JSON.stringify(summary, null, 2));
    if (violations.length) process.exitCode = 2;
  } finally {
    target.close();
    await source.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
  process.exit(1);
});
