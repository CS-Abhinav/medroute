// Road-network distances and route geometry.
// Uses the public OSRM demo server; falls back to haversine x detour factor
// when offline so the app always works.

const { haversineKm } = require('./geo');

const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';
const RIDER_SPEED_KMH = 22;      // average two-wheeler speed in city traffic
const DETOUR_FACTOR = 1.35;      // road distance ~= 1.35 x straight-line distance in Chennai
const OSRM_TABLE_LIMIT = 90;     // demo server rejects very large tables
const TIMEOUT_MS = 7000;

let osrmHealthy = true;
let lastOsrmFailure = 0;
const cache = new Map();

const kmToMin = km => (km / RIDER_SPEED_KMH) * 60;

async function fetchJson(url) {
  // After a failure, skip OSRM for 60 s instead of waiting for timeouts repeatedly
  if (!osrmHealthy && Date.now() - lastOsrmFailure < 60000) throw new Error('OSRM marked unavailable');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'MedRoute-college-demo' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.code && json.code !== 'Ok') throw new Error('OSRM ' + json.code);
    osrmHealthy = true;
    return json;
  } catch (e) {
    osrmHealthy = false;
    lastOsrmFailure = Date.now();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const coordStr = pts => pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

function fallbackMatrix(points) {
  const n = points.length;
  const dist = [], time = [];
  for (let i = 0; i < n; i++) {
    dist.push([]); time.push([]);
    for (let j = 0; j < n; j++) {
      const d = i === j ? 0 : haversineKm(points[i], points[j]) * DETOUR_FACTOR;
      dist[i].push(d); time[i].push(kmToMin(d));
    }
  }
  return { dist, time, source: 'haversine' };
}

// Full n x n distance (km) / time (min) matrix.
async function distanceMatrix(points) {
  const key = 'M' + coordStr(points);
  if (cache.has(key)) return cache.get(key);
  let result;
  if (points.length <= OSRM_TABLE_LIMIT && points.length > 1) {
    try {
      const json = await fetchJson(`${OSRM}/table/v1/driving/${coordStr(points)}?annotations=distance`);
      const fb = fallbackMatrix(points);
      const dist = json.distances.map((row, i) => row.map((m, j) => (m == null ? fb.dist[i][j] : m / 1000)));
      result = { dist, time: dist.map(r => r.map(kmToMin)), source: 'osrm' };
    } catch (e) {
      result = fallbackMatrix(points);
    }
  } else {
    result = fallbackMatrix(points);
  }
  cache.set(key, result);
  return result;
}

// One source to many destinations (used for isochrones and pharmacy ranking).
async function oneToMany(source, dests) {
  const out = [];
  for (let i = 0; i < dests.length; i += OSRM_TABLE_LIMIT - 1) {
    const chunk = dests.slice(i, i + OSRM_TABLE_LIMIT - 1);
    let km;
    try {
      const json = await fetchJson(
        `${OSRM}/table/v1/driving/${coordStr([source, ...chunk])}?sources=0&annotations=distance`);
      km = json.distances[0].slice(1).map((m, k) =>
        m == null ? haversineKm(source, chunk[k]) * DETOUR_FACTOR : m / 1000);
    } catch (e) {
      km = chunk.map(d => haversineKm(source, d) * DETOUR_FACTOR);
    }
    out.push(...km);
  }
  return out.map(d => ({ km: d, min: kmToMin(d) }));
}

// Road geometry through ordered waypoints, split into one polyline per leg.
// Returns { legs: [[[lat,lng],...], ...], source }
async function routeGeometry(points) {
  if (points.length < 2) return { legs: [], source: 'none' };
  const key = 'R' + coordStr(points);
  if (cache.has(key)) return cache.get(key);
  let result;
  try {
    const json = await fetchJson(
      `${OSRM}/route/v1/driving/${coordStr(points)}?overview=full&geometries=geojson&steps=false`);
    const line = json.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    // Split the overall polyline into legs using OSRM's per-leg distances:
    // walk the cumulative length and cut where each leg's distance is used up.
    const cum = [0];
    for (let k = 1; k < line.length; k++) {
      cum.push(cum[k - 1] + haversineKm({ lat: line[k - 1][0], lng: line[k - 1][1] }, { lat: line[k][0], lng: line[k][1] }));
    }
    const scale = cum[cum.length - 1] / (json.routes[0].distance / 1000 || 1);
    const idx = [0];
    let target = 0, k = 0;
    for (const leg of json.routes[0].legs.slice(0, -1)) {
      target += (leg.distance / 1000) * scale;
      while (k < line.length - 1 && cum[k] < target) k++;
      idx.push(k);
    }
    idx.push(line.length - 1);
    const legs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const seg = line.slice(idx[i], idx[i + 1] + 1);
      // glue the real (un-snapped) stop coordinates onto each end
      legs.push([[points[i].lat, points[i].lng], ...seg, [points[i + 1].lat, points[i + 1].lng]]);
    }
    result = { legs, source: 'osrm' };
  } catch (e) {
    const legs = [];
    for (let i = 0; i < points.length - 1; i++) {
      legs.push([[points[i].lat, points[i].lng], [points[i + 1].lat, points[i + 1].lng]]);
    }
    result = { legs, source: 'straight-line' };
  }
  cache.set(key, result);
  return result;
}

module.exports = {
  distanceMatrix, oneToMany, routeGeometry, kmToMin,
  RIDER_SPEED_KMH, DETOUR_FACTOR,
  status: () => ({ osrmHealthy, osrm: OSRM })
};
