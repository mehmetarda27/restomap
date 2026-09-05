const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function auditFixture(t) {
  const root = path.resolve(__dirname, '../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restomap-audit-'));
  const file = path.join(dir, 'audit.sqlite');
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_PATH: file, DB_PATH: file, DELIVERA_DB_FILE: file, DELIVERA_ADMIN_USERNAME: 'audit_admin', DELIVERA_ADMIN_PASSWORD: 'AuditPass123!', DELIVERA_ASSIGNMENT_RETRY_MS: '60000', LOG_LEVEL: 'error' };
  for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_PRIVATE_URL', 'POSTGRES_PRIVATE_URL', 'INTERNAL_DATABASE_URL', 'DATABASE_INTERNAL_URL', 'RENDER_DATABASE_URL', 'RENDER_POSTGRES_URL', 'POSTGRES_DATABASE_URL', 'PGDATABASE_URL', 'DATABASE_CONNECTION_STRING', 'POSTGRES_CONNECTION_STRING', 'REDIS_URL', 'RESTOMAP_FIREBASE_SERVICE_ACCOUNT', 'GOOGLE_APPLICATION_CREDENTIALS', 'POSENTEGRA_API_KEY', 'TELEGRAM_BOT_TOKEN']) env[name] = '';
  env.RESTOMAP_REQUIRE_REDIS = '0';
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  server.stderr.on('data', (chunk) => { errors += chunk; });
  let db;
  t.after(async () => {
    db?.close();
    if (server.exitCode === null) { server.kill(); await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]); }
    for (let i = 0; i < 10; i++) { try { fs.rmSync(dir, { recursive: true }); break; } catch { await delay(100); } }
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {} await delay(100); }
  if (!ready) throw Error(errors || 'Audit server did not start');
  db = new DatabaseSync(file);
  const stamp = new Date().toISOString();
  const salt = 'audit-salt';
  const hash = crypto.scryptSync('AuditPass123!', salt, 64).toString('hex');
  for (const suffix of ['a', 'b']) {
    db.prepare('INSERT INTO restaurants (id,name,zone,x,y,platforms_json,api_key,webhook_secret,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`r_${suffix}`, `Audit Restaurant ${suffix}`, 'Akdeniz', 36.8, 34.6, '[]', `key_${suffix}`, `secret_${suffix}`, stamp);
    db.prepare('INSERT INTO couriers (id,name,zone,x,y,available,status,username,password_hash,password_salt,per_package_fee,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`c_${suffix}`, `Audit Courier ${suffix}`, 'Akdeniz', 36.8, 34.6, 0, 'offline', `audit_${suffix}`, hash, salt, 10.30, stamp);
    db.prepare('INSERT INTO courier_sessions (token,courier_id,created_at) VALUES (?,?,?)').run(`c_${suffix}`, `c_${suffix}`, stamp);
    db.prepare('INSERT INTO restaurant_sessions (token,restaurant_id,created_at) VALUES (?,?,?)').run(`r_${suffix}`, `r_${suffix}`, stamp);
  }
  async function request(route, token = '', method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const auth = await request('/api/admin/login', '', 'POST', { username: 'audit_admin', password: 'AuditPass123!' });
  if (auth.status !== 200) throw Error(JSON.stringify(auth));
  return { db, request, admin: auth.body.token, base, root, stamp };
}
module.exports = { auditFixture };
