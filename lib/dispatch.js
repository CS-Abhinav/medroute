// Dispatch + live delivery simulation.
// Simulation clock: 1 simulated minute = 60000 / simSpeed real milliseconds.
const { store } = require('./store');
const { distanceMatrix, routeGeometry } = require('./routing');
const { optimise } = require('./optimizer');
const { haversineKm } = require('./geo');

const msPerMin = () => 60000 / store.settings.simSpeed;

function setStatus(order, status, note) {
  if (order.status === status) return;
  order.status = status;
  order.statusHistory.push({ status, at: Date.now(), note });
}

// ----- rider position along its legs -----
function interpolate(path, frac) {
  if (path.length === 1 || frac <= 0) return { lat: path[0][0], lng: path[0][1] };
  if (frac >= 1) return { lat: path[path.length - 1][0], lng: path[path.length - 1][1] };
  const segs = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = haversineKm({ lat: path[i - 1][0], lng: path[i - 1][1] }, { lat: path[i][0], lng: path[i][1] });
    segs.push(d); total += d;
  }
  let target = frac * total;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const f = segs[i] ? Math.min(1, target / segs[i]) : 0;
      return {
        lat: path[i][0] + (path[i + 1][0] - path[i][0]) * f,
        lng: path[i][1] + (path[i + 1][1] - path[i][1]) * f
      };
    }
    target -= segs[i];
  }
}

function riderPosition(rider, now = Date.now()) {
  if (!rider.legs.length) return { ...rider.home, moving: false };
  for (const leg of rider.legs) {
    if (now < leg.departAt) return { ...interpolate(leg.path, 0), moving: false };
    if (now < leg.arriveAt) {
      const frac = (now - leg.departAt) / (leg.arriveAt - leg.departAt);
      return { ...interpolate(leg.path, frac), moving: true, heading: leg.toStop };
    }
  }
  const last = rider.legs[rider.legs.length - 1].path;
  return { lat: last[last.length - 1][0], lng: last[last.length - 1][1], moving: false };
}

// Update order statuses from the simulation clock.
function refreshStatuses(now = Date.now()) {
  for (const o of store.orders) {
    if (!o.plan || o.status === 'delivered') continue;
    if (now >= o.plan.dropAt) {
      if (o.status !== 'picked_up') setStatus(o, 'picked_up', 'Collected from pharmacy');
      setStatus(o, 'delivered', 'Delivered to customer');
    } else if (now >= o.plan.pickupDepartAt) setStatus(o, 'picked_up', 'Collected from pharmacy');
  }
}

let running = false;

async function dispatch({ reason = 'manual' } = {}) {
  if (running) return { error: 'Optimisation already running' };
  running = true;
  try {
    refreshStatuses();
    const now = Date.now();
    const mpm = msPerMin();
    const pending = store.orders.filter(o => o.status === 'approved');
    if (!pending.length) return { error: 'No approved orders waiting for dispatch' };

    // Riders start from their current position (idle) or their last planned stop (busy)
    const riders = store.riders.map(r => {
      const last = r.stops[r.stops.length - 1];
      const busy = last && last.departAt > now;
      const start = busy ? { lat: last.lat, lng: last.lng } : riderPosition(r, now);
      const availableAt = busy ? last.departAt : now;
      return { id: r.id, capacity: r.capacity, lat: start.lat, lng: start.lng, availableAt,
        startOffsetMin: (availableAt - now) / mpm };
    });
    const orders = pending.map(o => ({
      id: o.id, priority: o.priority, coldChain: o.coldChain, createdAt: o.createdAt,
      pickup: o.pickup, drop: o.drop
    }));
    const points = [...riders, ...orders.flatMap(o => [o.pickup, o.drop])];
    const matrix = await distanceMatrix(points);
    const result = optimise({ riders, orders, matrix, iterations: Math.min(9000, 1500 + orders.length * 400) });

    // Commit: absolute times + road geometry
    const routes = [];
    for (let r = 0; r < riders.length; r++) {
      const plan = result.optimised.perRider[r];
      const rider = store.riders[r];
      if (!plan.stops.length) continue;
      const wp = [{ lat: riders[r].lat, lng: riders[r].lng }, ...plan.stops];
      const geo = await routeGeometry(wp);
      let prevDepart = riders[r].availableAt;
      plan.stops.forEach((s, i) => {
        const stop = {
          type: s.type, orderId: s.orderId, lat: s.lat, lng: s.lng,
          arriveAt: now + s.arriveMin * mpm, departAt: now + s.departMin * mpm,
          legKm: +s.legKm.toFixed(2)
        };
        const order = store.orders.find(o => o.id === s.orderId);
        stop.label = s.type === 'pickup' ? order.pickup.name : order.customerName;
        rider.stops.push(stop);
        rider.legs.push({ path: geo.legs[i], departAt: prevDepart, arriveAt: stop.arriveAt, toStop: rider.stops.length - 1 });
        prevDepart = stop.departAt;
        order.riderId = rider.id;
        order.plan = order.plan || {};
        if (s.type === 'pickup') { order.plan.pickupAt = stop.arriveAt; order.plan.pickupDepartAt = stop.departAt; }
        else order.plan.dropAt = stop.arriveAt;
      });
      routes.push({ riderId: rider.id, riderName: rider.name, geometry: geo.legs, geometrySource: geo.source,
        km: +plan.km.toFixed(2), minutes: +plan.minutes.toFixed(1), stops: rider.stops.slice(-plan.stops.length) });
    }
    for (const o of pending) {
      if (o.riderId) {
        const rider = store.riders.find(r => r.id === o.riderId);
        setStatus(o, 'assigned', `Assigned to ${rider.name} (${rider.id})`);
      }
    }
    // Baseline drawn as straight segments (it is only a comparison sketch)
    const baselineRoutes = result.baseline.perRider
      .map((p, r) => ({ riderId: p.riderId, path: [[riders[r].lat, riders[r].lng], ...p.stops.map(s => [s.lat, s.lng])] }))
      .filter(b => b.path.length > 1);
    store.lastDispatch = {
      at: now, reason, orderCount: orders.length, matrixSource: matrix.source,
      optimised: result.optimised.totals, baseline: result.baseline.totals,
      savings: result.savings, log: result.log, runtimeMs: result.runtimeMs,
      routes, baselineRoutes, unassigned: result.unassigned
    };
    return store.lastDispatch;
  } finally {
    running = false;
  }
}

// Auto-dispatch: batch orders for a short window, then optimise them together.
function startAutoDispatch() {
  setInterval(async () => {
    refreshStatuses();
    if (!store.settings.autoDispatch) return;
    const pending = store.orders.filter(o => o.status === 'approved');
    if (!pending.length) return;
    const oldest = Math.min(...pending.map(o => o.approvedAt || o.createdAt));
    if (Date.now() - oldest < store.settings.batchWindowSec * 1000) return;
    try { await dispatch({ reason: 'auto' }); } catch (e) { console.error('Auto-dispatch failed', e); }
  }, 3000);
}

module.exports = { dispatch, riderPosition, refreshStatuses, startAutoDispatch, setStatus, msPerMin };
