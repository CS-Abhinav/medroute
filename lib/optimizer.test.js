// Offline sanity check for the optimiser (no network): `npm run test:optimizer`
const { optimise, benchmark } = require('./optimizer');
const { haversineKm, rng } = require('./geo');

function matrixFor(points) {
  const dist = points.map(a => points.map(b => haversineKm(a, b) * 1.35));
  return { dist, time: dist.map(r => r.map(d => (d / 22) * 60)) };
}
const rand = rng(7);
const pt = () => ({ lat: 12.95 + rand() * 0.15, lng: 80.15 + rand() * 0.12 });

// Multi-rider instance
const riders = Array.from({ length: 4 }, (_, i) => ({ id: 'R' + i, capacity: 4, ...pt() }));
const orders = Array.from({ length: 16 }, (_, i) => ({
  id: 'O' + i, pickup: pt(), drop: pt(), priority: i % 5 === 0 ? 'urgent' : 'normal',
  coldChain: i % 7 === 0, createdAt: i
}));
const pts = [...riders, ...orders.flatMap(o => [o.pickup, o.drop])];
const res = optimise({ riders, orders, matrix: matrixFor(pts) });
console.log(res.log.join('\n'));
console.log('Optimised', res.optimised.totals);
console.log('Baseline ', res.baseline.totals);
console.log('Savings  ', res.savings);

// Each order must be picked up before drop, by the same rider
for (const r of res.optimised.perRider) {
  const seen = new Set();
  for (const s of r.stops) {
    if (s.type === 'pickup') seen.add(s.orderId);
    else if (!seen.has(s.orderId)) throw new Error('Precedence violated for ' + s.orderId);
  }
}
const served = res.optimised.perRider.flatMap(r => r.stops.filter(s => s.type === 'drop')).length;
if (served !== orders.length) throw new Error(`Only ${served}/${orders.length} delivered`);

// Exact vs heuristic on single-rider instances
for (let n = 3; n <= 7; n++) {
  const rider = { id: 'R', capacity: 3, ...pt() };
  const os = orders.slice(0, n);
  const b = benchmark({ rider, orders: os, matrix: matrixFor([rider, ...os.flatMap(o => [o.pickup, o.drop])]) });
  console.log(`n=${n} exact=${b.exactMinutes} heuristic=${b.heuristicMinutes} naive=${b.naiveMinutes} gap=${b.gapPct}%`);
  if (b.heuristicMinutes < b.exactMinutes - 1e-6) throw new Error('Heuristic beat the exact optimum - DP bug');
}
console.log('All optimiser checks passed');
