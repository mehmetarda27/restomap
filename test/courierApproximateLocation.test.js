const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFixture } = require('./helpers/auditFixture');

test('on-route falls back to an approximate nearby point and avoids courier self-notification noise', { timeout: 30000 }, async (t) => {
  const { db, request, stamp } = await auditFixture(t, {
    env: { GEOCODING_API_URL: 'http://127.0.0.1:9/geocoder-unavailable' },
  });
  db.prepare(`INSERT INTO packages (
    id, tracking_no, restaurant_id, source, source_platform, external_order_no, recipient, phone, address, zone, eta,
    payment_method, payment_status, order_amount, x, y, note, status, assignment_status, assigned_courier_id,
    assigned_courier_name, assigned_at, assignment_reason, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('pkg_approximate', 'PKT-APPROX', 'r_a', 'restaurant_panel', 'Manuel', 'APPROX-1', 'Adres Test', '05320000000',
      'Haritada bulunamayan test adresi', 'Akdeniz', '15 dk', 'paid_online', 'paid_online', 100, 36.8, 34.6, '',
      'accepted_by_courier', 'assigned', 'c_a', 'Audit Courier a', stamp, 'Test ataması', stamp, stamp);
  db.prepare('DELETE FROM notification_logs').run();

  const result = await request('/api/courier/packages/pkg_approximate/status', 'c_a', 'PATCH', { status: 'on_route' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const pkg = result.body.packages.find((item) => item.id === 'pkg_approximate');
  assert.equal(pkg.status, 'on_route');
  assert.equal(pkg.customerLat, 36.8);
  assert.equal(pkg.customerLng, 34.6);
  assert.equal(pkg.customerLocationQuality, 'approximate');

  const notifications = db.prepare('SELECT target_role, target_id, event_type, message FROM notification_logs ORDER BY created_at').all();
  const courierWarnings = notifications.filter((item) => item.target_role === 'courier' && item.target_id === 'c_a');
  assert.equal(courierWarnings.length, 1);
  assert.equal(courierWarnings[0].event_type, 'package-location-warning');
  assert.match(courierWarnings[0].message, /konum doğru olmayabilir/i);
  assert.equal(notifications.filter((item) => item.target_role === 'courier' && item.event_type === 'package-status').length, 0);
  assert.equal(notifications.filter((item) => item.target_role === 'restaurant' && item.target_id === 'r_a' && item.event_type === 'package-status').length, 1);
  assert.equal(notifications.filter((item) => item.target_role === 'admin' && item.event_type === 'package-status').length, 1);

  db.prepare('INSERT INTO courier_shifts (id, courier_id, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
    .run('shift_notification_noise', 'c_b', stamp, stamp, stamp);
  db.prepare("UPDATE couriers SET available = 1, status = 'online' WHERE id = 'c_b'").run();
  db.prepare('DELETE FROM notification_logs').run();

  const breakResult = await request('/api/courier/break', 'c_b', 'POST', { action: 'start' });
  assert.equal(breakResult.status, 200, JSON.stringify(breakResult.body));
  const breakNotifications = db.prepare("SELECT target_role, target_id FROM notification_logs WHERE event_type = 'courier-break'").all();
  assert.equal(breakNotifications.filter((item) => item.target_role === 'courier' && item.target_id === 'c_b').length, 0);
  assert.equal(breakNotifications.filter((item) => item.target_role === 'admin').length, 1);
});
