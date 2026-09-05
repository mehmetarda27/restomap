const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFixture } = require('./helpers/auditFixture');

test('full audit: notifications, role isolation, DB integrity and paid earnings', { timeout: 45000 }, async (t) => {
  const { db, request, admin, stamp, base } = await auditFixture(t);
  await t.test('SSE announcement is role-scoped and reconnect retrieves persisted notifications', async () => {
    const streams = [];
    try {
      for (const role of ['courier', 'restaurant']) {
        const controller = new AbortController();
        const response = await fetch(`${base}/api/${role}/stream?token=${role === 'courier' ? 'c_b' : 'r_b'}`, { signal: controller.signal });
        assert.equal(response.status, 200);
        const stream = { controller, text: '', reader: response.body.getReader() };
        streams.push(stream);
        stream.pump = (async () => { try { while (true) { const part = await stream.reader.read(); if (part.done) break; stream.text += new TextDecoder().decode(part.value); } } catch (error) { if (!controller.signal.aborted) throw error; } })();
      }
      const announcement = await request('/api/admin/announcements', admin, 'POST', { targetRole: 'courier', title: 'SSE audit', message: 'SSE role test' });
      assert.equal(announcement.status, 200);
      for (let i=0;i<50 && !streams[0].text.includes('SSE audit');i++) await new Promise(resolve=>setTimeout(resolve,20));
      assert.ok(streams[0].text.includes('SSE audit'));
      assert.ok(!streams[1].text.includes('SSE audit'));
    } finally {
      for (const stream of streams) stream.controller.abort();
      await Promise.all(streams.map(stream=>stream.pump));
    }
    const reconnected = await request('/api/courier/me', 'c_b');
    assert.ok(reconnected.body.notifications.some(item=>item.message.includes('SSE audit')));
  });
  await t.test('unread count includes records outside the displayed page', async () => {
    const before = (await request('/api/courier/me', 'c_a')).body.unreadNotificationCount;
    for (let i = 0; i < 35; i++) db.prepare('INSERT INTO notification_logs (id,target_role,target_id,event_type,message,created_at) VALUES (?,?,?,?,?,?)').run(`audit_n_${i}`, 'courier', 'c_a', 'workspace-update', `Audit ${i}`, stamp);
    const result = await request('/api/courier/me', 'c_a');
    assert.equal(result.status, 200);
    assert.equal(result.body.notifications.length, 20);
    assert.equal(result.body.unreadNotificationCount, before + 35);
  });
  await t.test('malformed selected-read never marks every notification', async () => {
    const result = await request('/api/courier/notifications/read', 'c_a', 'POST', { ids: 'audit_n_0' });
    assert.equal(result.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_logs WHERE target_id='c_a' AND read_at IS NOT NULL").get().n, 0);
  });
  await t.test('read-one/read-all remain recipient-scoped and idempotent', async () => {
    db.prepare('INSERT INTO notification_logs (id,target_role,target_id,event_type,message,created_at) VALUES (?,?,?,?,?,?)').run('audit_b', 'courier', 'c_b', 'workspace-update', 'Private B', stamp);
    assert.equal((await request('/api/courier/notifications/read', 'c_a', 'POST', { ids: ['audit_b'] })).body.changed, 0);
    assert.equal((await request('/api/courier/notifications/read', 'c_a', 'POST', { ids: ['audit_n_0'] })).body.changed, 1);
    assert.equal((await request('/api/courier/notifications/read', 'c_a', 'POST', { ids: ['audit_n_0'] })).body.changed, 0);
    await request('/api/courier/notifications/read', 'c_a', 'POST', {});
    assert.equal(db.prepare("SELECT read_at FROM notification_logs WHERE id='audit_b'").get().read_at, null);
    assert.equal((await request('/api/courier/me', 'c_a')).body.unreadNotificationCount, 0);
  });
  await t.test('courier announcement persists only to its declared role', async () => {
    const result = await request('/api/admin/announcements', admin, 'POST', { targetRole: 'courier', title: 'Audit private announcement', message: 'Couriers only' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    for (const id of ['c_a', 'c_b']) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_logs WHERE target_id=? AND message LIKE ?').get(id, '%Audit private announcement%').n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_logs WHERE target_role='restaurant' AND message LIKE '%Audit private announcement%'").get().n, 0);
    const restaurant = await request('/api/restaurant/bootstrap', 'r_a');
    assert.ok(!restaurant.body.announcements.some((item) => item.title === 'Audit private announcement'));
  });
  await t.test('admin endpoints reject courier and restaurant sessions', async () => {
    for (const actor of ['c_a', 'r_a']) {
      for (const route of ['/api/admin/bootstrap', '/api/admin/management-records', '/api/admin/courier-earnings', '/api/admin/restaurants/r_b/credits', '/api/admin/reports/account']) {
        assert.ok([401, 403].includes((await request(route, actor)).status), `${actor} ${route}`);
      }
    }
  });
  await t.test('foreign IDs cannot change self-scoped restaurant or courier reads', async () => {
    await request('/api/admin/restaurants/r_b/credits', admin, 'POST', { eventKey: 'private-credit', amount: 10, reason: 'B only' });
    const credits = await request('/api/restaurant/credits?business_id=r_b&restaurantId=r_b', 'r_a');
    assert.equal(credits.status, 200);
    assert.equal(credits.body.account.restaurantId, 'r_a');
    assert.equal(credits.body.account.balance, 0);
    const courier = await request('/api/courier/me?courier_id=c_b&courierId=c_b', 'c_a');
    assert.equal(courier.body.courier.id, 'c_a');
    assert.ok(!courier.body.notifications.some((item) => item.id === 'audit_b'));
  });
  await t.test('paid earning cannot be rewritten even with an admin note', async () => {
    const created = await request('/api/admin/management-records', admin, 'POST', { recordType: 'courier_adjustment', subjectType: 'courier', subjectId: 'c_a', title: 'Audit bonus', amount: 10.30, startDate: '2026-09-01' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const earning = db.prepare("SELECT * FROM courier_earnings WHERE courier_id='c_a' AND report_date='2026-09-01'").get();
    assert.equal((await request(`/api/admin/courier-earnings/${earning.id}/mark-paid`, admin, 'POST', {})).status, 200);
    const paid = db.prepare('SELECT * FROM courier_earnings WHERE id=?').get(earning.id);
    assert.equal((await request(`/api/admin/courier-earnings/${earning.id}/mark-paid`, admin, 'POST', { paidAt: '2026-09-02', adminNote: 'Retry must not rewrite history' })).status, 200);
    assert.deepEqual(db.prepare('SELECT * FROM courier_earnings WHERE id=?').get(earning.id), paid);
    const changed = await request(`/api/admin/courier-earnings/${earning.id}`, admin, 'PATCH', { bonusAmount: 900, adminNote: 'Must not rewrite paid history' });
    assert.equal(changed.status, 409);
    assert.equal(db.prepare('SELECT total_payable FROM courier_earnings WHERE id=?').get(earning.id).total_payable, 10.30);
  });
  await t.test('database integrity and financial foreign keys', () => {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });
  await t.test('restaurant order automatically assigns, accepts, travels and delivers with isolated writes', async () => {
    db.prepare("UPDATE couriers SET available=1,status='online',last_location_at=? WHERE id='c_a'").run(new Date().toISOString());
    const created = await request('/api/restaurant/packages', 'r_a', 'POST', { customerName: 'Audit Flow', phone: '05321112233', deliveryAddress: 'Test adresi', orderAmount: 103, paymentMethod: 'paid_online' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.createdPackage.id;
    const row = () => db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    assert.equal(row().assigned_courier_id, 'c_a');
    const foreign = await request(`/api/courier/packages/${id}/status`, 'c_b', 'PATCH', { status: 'accepted_by_courier' });
    assert.ok([403,404].includes(foreign.status), JSON.stringify(foreign));
    assert.equal(row().status, 'assigned');
    const foreignPoint = await request(`/api/restaurant/packages/${id}/delivery-point`, 'r_b', 'PATCH', { latitude: 36.801, longitude: 34.601 });
    assert.ok([403,404].includes(foreignPoint.status), JSON.stringify(foreignPoint));
    const point = await request(`/api/restaurant/packages/${id}/delivery-point`, 'r_a', 'PATCH', { latitude: 36.801, longitude: 34.601 });
    assert.equal(point.status, 200, JSON.stringify(point.body));
    for (const status of ['accepted_by_courier', 'on_route', 'delivered']) {
      const result = await request(`/api/courier/packages/${id}/status`, 'c_a', 'PATCH', { status });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(row().status, status);
    }
    assert.ok(row().delivered_at);
    const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const generated = await request('/api/admin/courier-earnings/generate', admin, 'POST', { date: reportDate, courierId: 'c_a' });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const earning = db.prepare('SELECT * FROM courier_earnings WHERE courier_id=? AND report_date=?').get('c_a', reportDate);
    assert.ok(earning);
    assert.equal(earning.delivered_package_count, 1);
    assert.equal(earning.total_payable, 10.30);
    const report = await request(`/api/restaurant/reports/account?date=${reportDate}`, 'r_a');
    assert.equal(report.body.summary.deliveredCount, 1);
    assert.equal((await request(`/api/restaurant/reports/account?date=${reportDate}`, 'r_b')).body.summary.totalOrders, 0);
  });
  await t.test('ten-order report counts seven delivered, two cancelled and one active exactly once', async () => {
    const when = '2026-09-03T10:00:00.000Z';
    const insert = db.prepare(`INSERT INTO packages
      (id,tracking_no,restaurant_id,source,source_platform,external_order_no,recipient,phone,address,zone,eta,payment_method,order_amount,payment_status,x,y,note,status,assignment_status,delivered_at,failed_at,assignment_reason,created_at,updated_at)
      VALUES (?,?,'r_a','restaurant_panel','Telefon',?,'Audit','05310000000','Test adresi','Akdeniz','20 dk','paid_online',10.30,'paid_online',36.8,34.6,'',?,?,?,?, 'audit',?,?)`);
    for (let i = 0; i < 10; i++) {
      const status = i < 7 ? 'delivered' : i < 9 ? 'cancelled' : 'pending';
      insert.run(`audit_report_${i}`, `AUDIT-${i}`, `AUDIT-${i}`, status, status, status === 'delivered' ? when : null, status === 'cancelled' ? when : null, when, when);
    }
    for (const [route, token] of [['/api/admin/reports/account', admin], ['/api/restaurant/reports/account', 'r_a']]) {
      const query = token === admin ? 'period=range&startDate=2026-09-03&endDate=2026-09-03' : 'date=2026-09-03';
      const report = await request(`${route}?${query}`, token);
      assert.equal(report.status, 200, JSON.stringify(report.body));
      assert.equal(report.body.summary.totalOrders, 10);
      assert.equal(report.body.summary.deliveredCount, 7);
      assert.equal(report.body.summary.cancelledCount, 2);
      assert.equal(report.body.summary.activeCount, 1);
      assert.equal(report.body.packages.length, 10);
    }
    const other = await request('/api/restaurant/reports/account?date=2026-09-03&restaurantId=r_a', 'r_b');
    assert.equal(other.body.summary.totalOrders, 0);
  });
});
