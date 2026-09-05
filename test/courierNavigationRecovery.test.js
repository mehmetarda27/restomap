const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'courier-design-bridge.js'), 'utf8');
function block(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test('route timeout retries, late replies cannot replace a changed destination, and route deviation is detected', async () => {
  const timers = [];
  const requests = [];
  let summary = '';
  const context = vm.createContext({
    AbortController, Date, Math, Number, String, Array, Infinity,
    window: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} },
    fetch(url, options) { return new Promise((resolve, reject) => { requests.push({url, resolve}); options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), {name:'AbortError'}))); }); },
    setNavigationMapControl(L, target, text) { summary = text; },
    clearNavigationRoute() {},
    validMapCoordinates(lat,lng) { return Number.isFinite(lat) && Number.isFinite(lng); },
  });
  vm.runInContext(`let navigationRouteLayer = null, navigationRouteAbortController = null, navigationRouteRequestId = 0, lastNavigationRouteKey = '', lastNavigationRouteSummary = '', routeRetryAt = 0, routeRequestedAt = 0, routeGeometry = [], leafletMap = {};
    let target = {latitude:36.81,longitude:34.61,type:'customer',packageId:'one'};
    function navigationTargetForPackages(){return target;}
    const L = {polyline(points){return {points,remove(){},addTo(){return this;}}}};
    ${block('function navigationRouteUrl', '  function liveMapBounds')}
    ${block('function distanceFromRouteMeters', '  function setNavigationMapControl')}
    ${block('async function updateNavigationRoute', '  async function updateRealLiveMap')}`, context);
  const first = vm.runInContext('updateNavigationRoute(L,{latitude:36.8,longitude:34.6})', context);
  timers[0](); await first;
  assert.match(summary, /kuş uçuşu.*tekrar/);
  vm.runInContext('routeRetryAt = 1', context);
  const second = vm.runInContext('updateNavigationRoute(L,{latitude:36.8,longitude:34.6})', context);
  assert.equal(requests.length, 2);
  vm.runInContext("target = {...target, packageId:'two',latitude:36.82}", context);
  const third = vm.runInContext('updateNavigationRoute(L,{latitude:36.8,longitude:34.6})', context);
  await second;
  requests[2].resolve({ok:true,json:async()=>({routes:[{geometry:{coordinates:[[34.6,36.8],[34.61,36.82]]},distance:3000,duration:300}]})});
  await third;
  assert.match(summary, /3.0 km/);
  assert.equal(vm.runInContext('routeGeometry[1][1]', context), 36.82);
  assert.ok(vm.runInContext('distanceFromRouteMeters({latitude:36.8,longitude:34.6}, [[34.6,36.79],[34.6,36.81]])', context) < 1);
  assert.ok(vm.runInContext('distanceFromRouteMeters({latitude:36.8,longitude:34.602}, [[34.6,36.79],[34.6,36.81]])', context) > 60);
});
