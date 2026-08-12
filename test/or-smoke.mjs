/* OptimoRoute smoke test. Run from repo root: node test/or-smoke.mjs
   - Auth check
   - CORS header check (can the phone browser call the API directly?)
   - Creates TEST- orders on a far-future date, plans, fetches routes,
     dumps real response shapes to test/output/, then DELETES the test orders.
   The API key is read from .env.local and never printed. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const KEY = (env.match(/OPTIMOROUTE_KEY=(\S+)/) || [])[1];
if (!KEY) { console.error('No OPTIMOROUTE_KEY in .env.local'); process.exit(1); }

const BASE = 'https://api.optimoroute.com/v1';
// Date can be overridden: node test/or-smoke.mjs 2026-08-19
// SAFETY: the script refuses to run if the date already has orders or routes,
// because start_planning would replan live dispatch data.
const TEST_DATE = process.argv[2] || '2026-09-20';
const redact = (s) => String(s).replaceAll(KEY, '<KEY>');

mkdirSync(new URL('./output/', import.meta.url), { recursive: true });

async function call(path, body, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set('key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), json, text };
}

function save(name, data) {
  writeFileSync(new URL(`./output/${name}.json`, import.meta.url), redact(JSON.stringify(data, null, 2)));
  console.log(`  saved test/output/${name}.json`);
}

const ADDRESSES = [
  { orderNo: 'TEST-BOX-1', name: 'Test One',   address: '1600 Pennsylvania Avenue NW, Washington, DC 20500', lat: 38.8977, lng: -77.0365 },
  { orderNo: 'TEST-BOX-2', name: 'Test Two',   address: '50 Massachusetts Ave NE, Washington, DC 20002',     lat: 38.8977, lng: -77.0063 },
  { orderNo: 'TEST-BOX-3', name: 'Test Three', address: '1000 Jefferson Dr SW, Washington, DC 20560',        lat: 38.8888, lng: -77.0261 },
  { orderNo: 'TEST-BOX-4', name: 'Test Four',  address: '401 F St NW, Washington, DC 20001',                 lat: 38.8977, lng: -77.0177 },
  { orderNo: 'TEST-BOX-5', name: 'Test Five',  address: '2 15th St NW, Washington, DC 20024',                lat: 38.8895, lng: -77.0353 }
];

async function main() {
  // 1) Auth check — cheap read.
  console.log('1) Auth check (get_routes on today)…');
  const auth = await call('/get_routes', null, { date: new Date().toISOString().slice(0, 10) });
  console.log('   HTTP', auth.status, redact(auth.text).slice(0, 200));
  if (auth.status === 401 || auth.status === 403 || (auth.json && auth.json.code === 'ERR_KEY')) {
    console.error('   AUTH FAILED — stopping. Key appears invalid.');
    process.exit(2);
  }

  // 2) CORS check — would a browser be allowed to call this?
  console.log('2) CORS check…');
  const cors = await fetch(BASE + '/get_routes?key=' + KEY + '&date=2026-01-01', {
    headers: { Origin: 'https://example.com' }
  });
  const acao = cors.headers.get('access-control-allow-origin');
  console.log('   Access-Control-Allow-Origin:', acao || '(absent — browser calls will be BLOCKED, proxy needed)');

  // 2.5) SAFETY: refuse to touch a date that already has orders or routes.
  console.log(`2.5) Safety check — is ${TEST_DATE} empty?`);
  const existingRoutes = await call('/get_routes', null, { date: TEST_DATE });
  if (existingRoutes.json?.routes?.length) {
    console.error(`   ABORT: ${TEST_DATE} already has ${existingRoutes.json.routes.length} route(s) — will not replan a live date.`);
    process.exit(3);
  }
  const existingOrders = await call('/search_orders', { dateRange: { from: TEST_DATE, to: TEST_DATE }, includeOrderData: false });
  if (existingOrders.json?.orders?.length) {
    console.error(`   ABORT: ${TEST_DATE} already has ${existingOrders.json.orders.length} order(s) — will not replan a live date.`);
    process.exit(3);
  }
  console.log('   Clear (search_orders HTTP ' + existingOrders.status + ', found ' + ((existingOrders.json?.orders || []).length) + ' orders).');

  // 3) Create test orders.
  console.log(`3) Creating ${ADDRESSES.length} TEST orders on ${TEST_DATE}…`);
  const created = await call('/create_or_update_orders', {
    orders: ADDRESSES.map((a) => ({
      operation: 'MERGE', orderNo: a.orderNo, type: 'D', date: TEST_DATE, duration: 5,
      location: { address: a.address, locationName: a.name, latitude: a.lat, longitude: a.lng }
    }))
  });
  console.log('   HTTP', created.status);
  save('create_orders_response', created.json ?? created.text);
  if (created.status !== 200) { console.error('   Create failed — stopping before planning.'); return cleanup(); }

  // 4) Plan.
  console.log('4) start_planning…');
  const plan = await call('/start_planning', { date: TEST_DATE });
  console.log('   HTTP', plan.status);
  save('start_planning_response', plan.json ?? plan.text);
  const planningId = plan.json && plan.json.planningId;
  if (plan.status !== 200 || plan.json?.success === false) {
    console.error('   Planning failed (often: no drivers configured for that date). See saved response.');
    return cleanup();
  }

  // 5) Poll.
  console.log('5) Polling get_planning_status…');
  let statusJson = null;
  const deadline = Date.now() + 180000;
  for (;;) {
    const st = await call('/get_planning_status', null, { planningId });
    statusJson = st.json;
    const s = st.json?.planning?.status ?? st.json?.status;
    console.log('   status:', s, '(HTTP', st.status + ')');
    if (s === 'F' || s === 'finished' || s === 'C') break;
    if (s === 'E' || s === 'error' || Date.now() > deadline) {
      console.error('   Planning did not finish cleanly.');
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  save('planning_status_response', statusJson);

  // 6) Routes.
  console.log('6) get_routes…');
  const routes = await call('/get_routes', null, { date: TEST_DATE });
  console.log('   HTTP', routes.status);
  save('get_routes_response', routes.json ?? routes.text);

  await cleanup();

  // 7) Summary of the shape we care about.
  const r = routes.json;
  if (r && r.routes) {
    console.log('\n=== STOP MAPPING EXTRACTED ===');
    for (const route of r.routes) {
      for (const stop of route.stops || []) {
        console.log(`  stopNumber=${stop.stopNumber} orderNo=${stop.orderNo} address=${stop.address || stop.locationName || ''}`);
      }
    }
  }
}

async function cleanup() {
  console.log('7) Deleting TEST orders…');
  for (const a of ADDRESSES) {
    const del = await call('/delete_order', { orderNo: a.orderNo });
    console.log(`   ${a.orderNo}: HTTP ${del.status} ${redact(del.text).slice(0, 120)}`);
  }
}

main().catch((e) => { console.error('FATAL:', redact(e.stack || e.message)); process.exit(1); });
