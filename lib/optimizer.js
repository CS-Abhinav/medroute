/*
 * MedRoute route optimiser
 * ------------------------
 * Problem: multi-vehicle Pickup-and-Delivery Problem (PDP) with
 *   - precedence   : a rider must visit the pharmacy (pickup) before the customer (drop)
 *   - capacity     : max number of parcels on board at once
 *   - priority     : urgent orders weigh more in the objective
 *   - cold chain   : insulin / vaccines must reach the customer within COLD_CHAIN_MAX_MIN of pickup
 *   - rider availability : busy riders start from their last planned stop, later in time
 *
 * Objective (minimise):
 *   total rider travel+service time
 *   + LAMBDA * sum(priorityWeight * deliveryTime)      (customer waiting time)
 *   + big penalties for cold-chain violations
 *
 * Pipeline:
 *   1. Regret-2 insertion  - construction heuristic (orders with the most to lose are placed first)
 *   2. Simulated annealing - relocate / exchange / 2-opt / or-opt moves, keeps best solution
 *   3. Local-search polish - deterministic best-improvement 2-opt + or-opt per route
 *   + Naive FCFS baseline (one order at a time, nearest rider) for comparison
 *   + Exact Held-Karp DP with precedence for small single-rider instances (benchmarking)
 *
 * Node indexing in the matrix: [0..R-1] rider starts, then for order k:
 *   pickup = R + 2k, drop = R + 2k + 1
 */

const SERVICE_MIN = { pickup: 3, drop: 2 };
const PRIORITY_WEIGHT = { normal: 1, urgent: 3 };
const LAMBDA = 0.5;
const COLD_CHAIN_MAX_MIN = 40;
const COLD_PENALTY = 1000;

function makeRng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Problem {
  constructor({ riders, orders, matrix, lambda = LAMBDA }) {
    this.riders = riders;
    this.orders = orders;
    this.R = riders.length;
    this.time = matrix.time;
    this.dist = matrix.dist;
    this.lambda = lambda;
  }
  pickupNode(k) { return this.R + 2 * k; }
  dropNode(k) { return this.R + 2 * k + 1; }
  isPickup(node) { return node >= this.R && (node - this.R) % 2 === 0; }
  orderOf(node) { return Math.floor((node - this.R) / 2); }

  // Evaluate one rider's route (array of nodes). Returns Infinity cost if infeasible.
  evalRoute(r, route) {
    const rider = this.riders[r];
    let t = rider.startOffsetMin || 0;
    let km = 0, load = rider.load || 0, prev = r;
    let waitCost = 0, penalty = 0;
    const pickedAt = {};
    const seen = new Set();
    for (const node of route) {
      t += this.time[prev][node];
      km += this.dist[prev][node];
      const k = this.orderOf(node);
      if (this.isPickup(node)) {
        load++;
        if (load > rider.capacity) return { cost: Infinity, feasible: false };
        seen.add(k);
        t += SERVICE_MIN.pickup;
        pickedAt[k] = t;
      } else {
        if (!seen.has(k)) return { cost: Infinity, feasible: false }; // drop before pickup
        load--;
        const o = this.orders[k];
        waitCost += (PRIORITY_WEIGHT[o.priority] || 1) * t;
        if (o.coldChain && t - pickedAt[k] > COLD_CHAIN_MAX_MIN) penalty += COLD_PENALTY;
        t += SERVICE_MIN.drop;
      }
      prev = node;
    }
    const travel = t - (rider.startOffsetMin || 0);
    return { cost: travel + this.lambda * waitCost + penalty, travel, km, feasible: true, penalty };
  }

  totalCost(routes) {
    let c = 0;
    for (let r = 0; r < routes.length; r++) c += this.evalRoute(r, routes[r]).cost;
    return c;
  }

  // Best position to insert order k into route r. O(L^2) positions x O(L) evaluation.
  bestInsertion(r, route, k) {
    const p = this.pickupNode(k), d = this.dropNode(k);
    const baseCost = this.evalRoute(r, route).cost;
    let best = { delta: Infinity, route: null };
    for (let i = 0; i <= route.length; i++) {
      for (let j = i; j <= route.length; j++) {
        const cand = route.slice(0, i).concat([p], route.slice(i, j), [d], route.slice(j));
        const c = this.evalRoute(r, cand).cost;
        if (c - baseCost < best.delta) best = { delta: c - baseCost, route: cand };
      }
    }
    return best;
  }
}

// ---------- 1. Regret-2 insertion ----------
function regretInsertion(P) {
  const routes = P.riders.map(() => []);
  const unassigned = new Set(P.orders.map((_, k) => k));
  while (unassigned.size) {
    let pick = null;
    for (const k of unassigned) {
      const opts = routes.map((route, r) => ({ r, ...P.bestInsertion(r, route, k) }))
        .filter(o => o.route).sort((a, b) => a.delta - b.delta);
      if (!opts.length) continue;
      const regret = (opts[1] ? opts[1].delta : 1e6) - opts[0].delta;
      // urgent orders get a boost so they are placed while good slots exist
      const score = regret * (PRIORITY_WEIGHT[P.orders[k].priority] || 1);
      if (!pick || score > pick.score) pick = { k, score, best: opts[0] };
    }
    if (!pick) break; // remaining orders cannot be placed (capacity)
    routes[pick.best.r] = pick.best.route;
    unassigned.delete(pick.k);
  }
  return { routes, unassigned: [...unassigned] };
}

// ---------- 2. Simulated annealing ----------
function removeOrder(P, route, k) {
  const p = P.pickupNode(k), d = P.dropNode(k);
  return route.filter(n => n !== p && n !== d);
}

function neighbour(P, routes, rand) {
  const R = routes.length;
  const nonEmpty = routes.map((r, i) => i).filter(i => routes[i].length);
  if (!nonEmpty.length) return null;
  const move = rand();
  const next = routes.slice();
  if (move < 0.4) {
    // RELOCATE an order to the best position in a (possibly different) route
    const a = nonEmpty[Math.floor(rand() * nonEmpty.length)];
    const pickups = routes[a].filter(n => P.isPickup(n));
    const k = P.orderOf(pickups[Math.floor(rand() * pickups.length)]);
    const b = Math.floor(rand() * R);
    next[a] = removeOrder(P, routes[a], k);
    const ins = P.bestInsertion(b, next[b], k);
    if (!ins.route) return null;
    next[b] = ins.route;
    return { routes: next, name: 'relocate' };
  } else if (move < 0.6 && nonEmpty.length >= 2) {
    // EXCHANGE one order between two routes
    const a = nonEmpty[Math.floor(rand() * nonEmpty.length)];
    let b = nonEmpty[Math.floor(rand() * nonEmpty.length)];
    if (a === b) return null;
    const ka = P.orderOf(routes[a].filter(n => P.isPickup(n))[0 | (rand() * (routes[a].length / 2))]);
    const kb = P.orderOf(routes[b].filter(n => P.isPickup(n))[0 | (rand() * (routes[b].length / 2))]);
    const ra = removeOrder(P, routes[a], ka), rb = removeOrder(P, routes[b], kb);
    const ia = P.bestInsertion(a, ra, kb), ib = P.bestInsertion(b, rb, ka);
    if (!ia.route || !ib.route) return null;
    next[a] = ia.route; next[b] = ib.route;
    return { routes: next, name: 'exchange' };
  } else if (move < 0.8) {
    // 2-OPT: reverse a segment inside one route
    const a = nonEmpty[Math.floor(rand() * nonEmpty.length)];
    const L = routes[a].length;
    if (L < 3) return null;
    let i = Math.floor(rand() * L), j = Math.floor(rand() * L);
    if (i > j) [i, j] = [j, i];
    if (j - i < 1) return null;
    next[a] = routes[a].slice(0, i).concat(routes[a].slice(i, j + 1).reverse(), routes[a].slice(j + 1));
    return { routes: next, name: '2-opt' };
  } else {
    // OR-OPT: move a single stop to another position in the same route
    const a = nonEmpty[Math.floor(rand() * nonEmpty.length)];
    const L = routes[a].length;
    const i = Math.floor(rand() * L), j = Math.floor(rand() * L);
    if (i === j) return null;
    const r = routes[a].slice();
    const [node] = r.splice(i, 1);
    r.splice(j, 0, node);
    next[a] = r;
    return { routes: next, name: 'or-opt' };
  }
}

function simulatedAnnealing(P, initial, { iterations = 6000, seed = 42 } = {}) {
  const rand = makeRng(seed);
  let current = initial, currentCost = P.totalCost(initial);
  let best = current, bestCost = currentCost;
  let T = Math.max(1, currentCost * 0.05);
  const cooling = Math.pow(0.001, 1 / iterations); // end at 0.1% of start temperature
  const accepted = { relocate: 0, exchange: 0, '2-opt': 0, 'or-opt': 0 };
  for (let it = 0; it < iterations; it++) {
    const nb = neighbour(P, current, rand);
    T *= cooling;
    if (!nb) continue;
    const c = P.totalCost(nb.routes);
    if (!isFinite(c)) continue;
    if (c < currentCost || rand() < Math.exp((currentCost - c) / T)) {
      current = nb.routes; currentCost = c; accepted[nb.name]++;
      if (c < bestCost - 1e-9) { best = current; bestCost = c; }
    }
  }
  return { routes: best, cost: bestCost, accepted };
}

// Run several annealing chains from the same start (different seeds) and keep the best
function multiStartSA(P, initial, { iterations, seed = 42, restarts = 4 }) {
  let best = null;
  for (let s = 0; s < restarts; s++) {
    const res = simulatedAnnealing(P, initial, { iterations, seed: seed + s * 7919 });
    res.routes = polish(P, res.routes);
    res.cost = P.totalCost(res.routes);
    if (!best || res.cost < best.cost) best = { ...res, seedUsed: seed + s * 7919 };
  }
  return best;
}

// ---------- 3. Deterministic local-search polish ----------
// Order reinsertion (remove a pickup+drop pair, put it back at the best spot in any route),
// then per-route or-opt and 2-opt, repeated until nothing improves.
function polish(P, routes) {
  let out = routes.map(r => r.slice());
  let improvedAny = true;
  while (improvedAny) {
    improvedAny = false;
    for (let k = 0; k < P.orders.length; k++) {
      const a = out.findIndex(r => r.includes(P.pickupNode(k)));
      if (a === -1) continue;
      {
        const before = P.totalCost(out);
        const removed = removeOrder(P, out[a], k);
        let bestRoutes = null, bestCost = before;
        for (let b = 0; b < out.length; b++) {
          const ins = P.bestInsertion(b, b === a ? removed : out[b], k);
          if (!ins.route) continue;
          const cand = out.slice();
          cand[a] = removed; cand[b] = ins.route;
          if (b === a) cand[a] = ins.route;
          const c = P.totalCost(cand);
          if (c < bestCost - 1e-9) { bestCost = c; bestRoutes = cand; }
        }
        if (bestRoutes) { out = bestRoutes; improvedAny = true; }
      }
    }
  }
  for (let r = 0; r < out.length; r++) {
    let improved = true;
    while (improved) {
      improved = false;
      let base = P.evalRoute(r, out[r]).cost;
      const L = out[r].length;
      // or-opt
      for (let i = 0; i < L && !improved; i++) {
        for (let j = 0; j < L && !improved; j++) {
          if (i === j) continue;
          const cand = out[r].slice();
          const [node] = cand.splice(i, 1);
          cand.splice(j, 0, node);
          const c = P.evalRoute(r, cand).cost;
          if (c < base - 1e-9) { out[r] = cand; improved = true; }
        }
      }
      // 2-opt
      for (let i = 0; i < L - 1 && !improved; i++) {
        for (let j = i + 1; j < L && !improved; j++) {
          const cand = out[r].slice(0, i).concat(out[r].slice(i, j + 1).reverse(), out[r].slice(j + 1));
          const c = P.evalRoute(r, cand).cost;
          if (c < base - 1e-9) { out[r] = cand; improved = true; }
        }
      }
    }
  }
  return out;
}

// ---------- Naive baseline: first-come-first-served, one order per trip ----------
function naiveFCFS(P) {
  const routes = P.riders.map(() => []);
  const order = P.orders.map((o, k) => k).sort((a, b) => (P.orders[a].createdAt || 0) - (P.orders[b].createdAt || 0));
  // each rider's "free at" time and position (node)
  const state = P.riders.map((rd, r) => ({ t: rd.startOffsetMin || 0, pos: r }));
  for (const k of order) {
    const p = P.pickupNode(k), d = P.dropNode(k);
    // nearest available rider = earliest arrival at the pharmacy
    let bestR = 0, bestArr = Infinity;
    state.forEach((s, r) => {
      const arr = s.t + P.time[s.pos][p];
      if (arr < bestArr) { bestArr = arr; bestR = r; }
    });
    routes[bestR].push(p, d);
    const s = state[bestR];
    s.t = bestArr + SERVICE_MIN.pickup + P.time[p][d] + SERVICE_MIN.drop;
    s.pos = d;
  }
  return routes;
}

// ---------- Exact DP (Held-Karp with precedence), single rider, <= 7 orders ----------
// Minimises pure route time (travel + service). Used to measure the heuristic's optimality gap.
function exactSingleRider(P, r = 0) {
  const n = P.orders.length;
  if (n > 7) throw new Error('Exact solver limited to 7 orders (14 stops)');
  const N = 2 * n;
  const node = i => P.R + i;                    // i even = pickup, odd = drop of order i>>1
  const cap = P.riders[r].capacity;
  const FULL = (1 << N) - 1;
  const dp = new Float64Array((1 << N) * N).fill(Infinity);
  const parent = new Int16Array((1 << N) * N).fill(-1);
  const svc = i => (i % 2 === 0 ? SERVICE_MIN.pickup : SERVICE_MIN.drop);
  for (let i = 0; i < N; i += 2) dp[(1 << i) * N + i] = P.time[r][node(i)] + svc(i);
  for (let mask = 1; mask <= FULL; mask++) {
    // load = pickups visited - drops visited
    let load = 0;
    for (let i = 0; i < N; i++) if (mask & (1 << i)) load += i % 2 === 0 ? 1 : -1;
    for (let last = 0; last < N; last++) {
      const cur = dp[mask * N + last];
      if (!isFinite(cur)) continue;
      for (let nx = 0; nx < N; nx++) {
        if (mask & (1 << nx)) continue;
        if (nx % 2 === 1 && !(mask & (1 << (nx - 1)))) continue; // drop needs pickup
        if (nx % 2 === 0 && load + 1 > cap) continue;
        const nm = mask | (1 << nx);
        const v = cur + P.time[node(last)][node(nx)] + svc(nx);
        if (v < dp[nm * N + nx]) { dp[nm * N + nx] = v; parent[nm * N + nx] = last; }
      }
    }
  }
  let best = Infinity, last = -1;
  for (let i = 1; i < N; i += 2) if (dp[FULL * N + i] < best) { best = dp[FULL * N + i]; last = i; }
  const seq = [];
  let mask = FULL;
  while (last !== -1) { seq.unshift(node(last)); const p = parent[mask * N + last]; mask &= ~(1 << last); last = p; }
  return { route: seq, time: best, states: (1 << N) * N };
}

// ---------- Summaries ----------
function summarise(P, routes) {
  let km = 0, travel = 0, sumDelivery = 0, maxDelivery = 0, deliveries = 0, coldViolations = 0;
  const perRider = routes.map((route, r) => {
    const rider = P.riders[r];
    let t = rider.startOffsetMin || 0, prev = r;
    const pickedAt = {};
    const stops = route.map(node => {
      const k = P.orderOf(node), o = P.orders[k];
      const legMin = P.time[prev][node], legKm = P.dist[prev][node];
      t += legMin; km += legKm;
      const arrive = t;
      const type = P.isPickup(node) ? 'pickup' : 'drop';
      if (type === 'pickup') pickedAt[k] = arrive;
      else {
        sumDelivery += arrive; maxDelivery = Math.max(maxDelivery, arrive); deliveries++;
        if (o.coldChain && arrive - pickedAt[k] > COLD_CHAIN_MAX_MIN) coldViolations++;
      }
      t += SERVICE_MIN[type];
      prev = node;
      return { type, orderId: o.id, node, arriveMin: arrive, departMin: t, legKm, legMin,
        lat: type === 'pickup' ? o.pickup.lat : o.drop.lat, lng: type === 'pickup' ? o.pickup.lng : o.drop.lng };
    });
    const ev = P.evalRoute(r, route);
    travel += ev.travel || 0;
    return { riderId: rider.id, stops, km: ev.km || 0, minutes: ev.travel || 0 };
  });
  return {
    perRider,
    totals: {
      km: +km.toFixed(2),
      riderMinutes: +travel.toFixed(1),
      avgDeliveryMin: deliveries ? +(sumDelivery / deliveries).toFixed(1) : 0,
      maxDeliveryMin: +maxDelivery.toFixed(1),
      ridersUsed: routes.filter(r => r.length).length,
      coldChainViolations: coldViolations,
      cost: +P.totalCost(routes).toFixed(1)
    }
  };
}

// ---------- Public entry point ----------
function optimise({ riders, orders, matrix, iterations = 6000, seed = 42 }) {
  const P = new Problem({ riders, orders, matrix });
  const t0 = Date.now();
  const log = [];
  const init = regretInsertion(P);
  const initCost = P.totalCost(init.routes);
  log.push(`Regret-2 insertion built ${orders.length - init.unassigned.length}/${orders.length} orders into routes, cost ${initCost.toFixed(1)}`);
  const sa = multiStartSA(P, init.routes, { iterations, seed });
  log.push(`Simulated annealing (4 chains x ${iterations} iterations) + reinsertion/2-opt/or-opt polish -> best cost ${sa.cost.toFixed(1)}; accepted moves in best chain ${JSON.stringify(sa.accepted)}`);
  const final = sa.routes;
  const naive = naiveFCFS(P);
  const optimised = summarise(P, final);
  const baseline = summarise(P, naive);
  log.push(`Naive FCFS baseline cost ${baseline.totals.cost} (${baseline.totals.km} km)`);
  const runtimeMs = Date.now() - t0;
  log.push(`Solved in ${runtimeMs} ms`);
  const pct = (a, b) => (b ? +(((b - a) / b) * 100).toFixed(1) : 0);
  return {
    optimised, baseline, log, runtimeMs,
    unassigned: init.unassigned.map(k => orders[k].id),
    savings: {
      kmPct: pct(optimised.totals.km, baseline.totals.km),
      riderMinutesPct: pct(optimised.totals.riderMinutes, baseline.totals.riderMinutes),
      avgDeliveryPct: pct(optimised.totals.avgDeliveryMin, baseline.totals.avgDeliveryMin),
      kmSaved: +(baseline.totals.km - optimised.totals.km).toFixed(2),
      co2KgSaved: +((baseline.totals.km - optimised.totals.km) * 0.05).toFixed(2) // ~50 g CO2/km for a 2-wheeler
    }
  };
}

// Benchmark the heuristic against the exact DP on a single-rider instance (time-only objective).
function benchmark({ rider, orders, matrix, iterations = 3000 }) {
  // The DP minimises pure route time, so drop cold-chain constraints for a like-for-like comparison
  orders = orders.map(o => ({ ...o, coldChain: false }));
  const P = new Problem({ riders: [rider], orders, matrix, lambda: 0 });
  const t0 = Date.now();
  const exact = exactSingleRider(P, 0);
  const tExact = Date.now() - t0;
  const t1 = Date.now();
  const init = regretInsertion(P);
  const heur = multiStartSA(P, init.routes, { iterations }).routes;
  const tHeur = Date.now() - t1;
  const heurTime = P.evalRoute(0, heur[0]).travel;
  const naive = naiveFCFS(P);
  const naiveTime = P.evalRoute(0, naive[0]).travel;
  return {
    orders: orders.length,
    exactMinutes: +exact.time.toFixed(2), exactMs: tExact, dpStates: exact.states,
    heuristicMinutes: +heurTime.toFixed(2), heuristicMs: tHeur,
    naiveMinutes: +naiveTime.toFixed(2),
    gapPct: +(((heurTime - exact.time) / exact.time) * 100).toFixed(2),
    exactRoute: exact.route, heuristicRoute: heur[0]
  };
}

module.exports = { optimise, benchmark, Problem, SERVICE_MIN, COLD_CHAIN_MAX_MIN, PRIORITY_WEIGHT };
