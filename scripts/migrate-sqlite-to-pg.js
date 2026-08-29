const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { Client } = require("pg");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const ROOT = path.resolve(__dirname, "..");
const currentDbFile = path.join(ROOT, "restomap.sqlite");
const legacyDbFile = path.join(ROOT, "delivera.sqlite");
const SQLITE_FILE = path.resolve(
  process.env.DATABASE_PATH ||
  process.env.DB_PATH ||
  process.env.RESTOMAP_DB_FILE ||
  process.env.DELIVERA_DB_FILE ||
  (fs.existsSync(currentDbFile) || !fs.existsSync(legacyDbFile) ? currentDbFile : legacyDbFile)
);
const { databaseUrl } = require("../db/config");
const PG_URL = databaseUrl();

async function main() {
  if (!fs.existsSync(SQLITE_FILE)) {
    console.log(`SQLite veritabanı bulunamadı: ${SQLITE_FILE}. Göç atlanıyor.`);
    return;
  }
  if (!PG_URL) {
    console.error("DATABASE_URL veya POSTGRES_URL bulunamadı. Göç iptal edildi.");
    process.exit(1);
  }

  console.log(`SQLite verileri okunuyor: ${SQLITE_FILE}`);
  const sqlite = new DatabaseSync(SQLITE_FILE);

  // Get SQLite tables
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);

  console.log(`Bulunan tablolar: ${tables.join(", ")}`);

  console.log("PostgreSQL bağlantısı kuruluyor...");
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();

  try {
    // Disable triggers and foreign keys temporarily for fast import
    await pg.query("SET session_replication_role = 'replica';");
    console.log("PostgreSQL foreign key ve triggerlar geçici olarak devre dışı bırakıldı.");

    for (const table of tables) {
      console.log(`\nTablo aktarılıyor: ${table}...`);

      // Read rows from SQLite
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      if (rows.length === 0) {
        console.log(`  Tablo boş, atlandı.`);
        continue;
      }

      // Clear target table in PG
      await pg.query(`TRUNCATE TABLE "${table}" CASCADE;`);

      // Get columns
      const cols = Object.keys(rows[0]);
      const colNames = cols.map((c) => `"${c}"`).join(", ");
      
      // Build parameterized insert query
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const query = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders});`;

      // Insert rows in transaction batch
      await pg.query("BEGIN;");
      try {
        for (const row of rows) {
          const values = cols.map((col) => {
            const val = row[col];
            // Handle null and boolean differences if any
            return val === undefined ? null : val;
          });
          await pg.query(query, values);
        }
        await pg.query("COMMIT;");
        console.log(`  Başarılı! ${rows.length} satır aktarıldı.`);
      } catch (err) {
        await pg.query("ROLLBACK;");
        console.error(`  Tablo aktarımı başarısız oldu: ${table}`, err);
        throw err;
      }
    }

    console.log("\nVeri aktarımı tamamlandı.");
  } finally {
    // Restore replication role
    try {
      await pg.query("SET session_replication_role = 'origin';");
      console.log("PostgreSQL triggers/FKs tekrar aktif edildi.");
    } catch {}
    await pg.end();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error("Göç sırasında kritik hata oluştu:", err);
  process.exit(1);
});
