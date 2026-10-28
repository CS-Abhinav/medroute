// Small geometry helpers used on the server.

const EARTH_RADIUS_KM = 6371;
const toRad = d => (d * Math.PI) / 180;

function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

// Ray-casting point-in-polygon. ring is [[lng, lat], ...]
function pointInPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const hit = (yi > pt.lat) !== (yj > pt.lat) &&
      pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Box-Muller gaussian sample
function gaussian(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample a random demand point near a weighted neighbourhood, inside the polygon.
function sampleDemandPoint(rand, centres, ring, spreadKm = 1.4) {
  const total = centres.reduce((s, c) => s + c.w, 0);
  for (let attempt = 0; attempt < 50; attempt++) {
    let r = rand() * total;
    let c = centres[0];
    for (const cc of centres) { r -= cc.w; if (r <= 0) { c = cc; break; } }
    const lat = c.lat + (gaussian(rand) * spreadKm) / 111;
    const lng = c.lng + (gaussian(rand) * spreadKm) / (111 * Math.cos(toRad(c.lat)));
    const pt = { lat, lng, area: c.area };
    if (pointInPolygon(pt, ring)) return pt;
  }
  return { lat: centres[0].lat, lng: centres[0].lng, area: centres[0].area };
}

module.exports = { haversineKm, pointInPolygon, sampleDemandPoint, rng };
