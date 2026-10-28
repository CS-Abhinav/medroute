const user = Auth.require('admin');
renderTopbar(user, '<a class="btn sm" href="/pharmacist.html">Prescription queue</a>');

const { map, layerControl } = createMap('map', { zoom: 12 });
const pharmacyLayer = L.layerGroup().addTo(map);
const pendingLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const naiveLayer = L.layerGroup();
const riderLayer = L.layerGroup().addTo(map);
const voronoiLayer = L.layerGroup(), coverageLayer = L.layerGroup(), isoLayer = L.layerGroup().addTo(map), nearestLayer = L.layerGroup().addTo(map);
let heatLayer = null;
layerControl.addOverlay(pharmacyLayer, 'Pharmacies');
layerControl.addOverlay(pendingLayer, 'Orders awaiting dispatch');
layerControl.addOverlay(routeLayer, 'Optimised rider routes');
layerControl.addOverlay(stopLayer, 'Route stop numbers');
layerControl.addOverlay(naiveLayer, 'Naive FCFS plan (comparison)');
layerControl.addOverlay(riderLayer, 'Live riders');

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const d = L.DomUtil.create('div', 'map-legend');
  d.id = 'legend';
  return d;
};
legend.addTo(map);

let STATE = null, PHARMACIES = [], SERVICE = null;
const riderMarkers = {};
let lastRoutesKey = '';

async function init() {
  const [phs, area] = await Promise.all([api('/api/pharmacies'), addServiceArea(map, layerControl)]);
  PHARMACIES = phs; SERVICE = area.geo;
  phs.forEach(p => L.marker([p.lat, p.lng], { icon: pinIcon('pharmacy', '✚', 22, p.open24 ? 'open24' : '') })
    .bindPopup(pharmacyPopup(p)).addTo(pharmacyLayer));
  isoPharmacy.innerHTML = phs.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  await refresh();
  setInterval(refresh, 1000);
}

// ---------------- live state ----------------
async function refresh() {
  try { STATE = await api('/api/admin/state'); } catch (e) { return; }
  const c = STATE.counts;
  stReview.textContent = (c.pending_review || 0) + (c.screening || 0);
  stWaiting.textContent = c.approved || 0;
  stTransit.textContent = (c.assigned || 0) + (c.picked_up || 0);
  stDelivered.textContent = c.delivered || 0;
  stRiders.textContent = `${STATE.riders.filter(r => r.upcoming).length}/${STATE.riders.length}`;
  stRouting.textContent = STATE.routing.osrmHealthy ? 'OSRM roads' : 'Fallback';
  if (document.activeElement !== autoDispatch) autoDispatch.checked = STATE.settings.autoDispatch;
  bwLabel.textContent = STATE.settings.batchWindowSec;
  if (document.activeElement !== simSpeed) simSpeed.value = STATE.settings.simSpeed;

  // pending orders
  pendingLayer.clearLayers();
  STATE.orders.filter(o => o.status === 'approved').forEach(o => {
    L.marker([o.drop.lat, o.drop.lng], { icon: pinIcon('drop', o.priority === 'urgent' ? '!' : o.coldChain ? '❄' : '•', 22) })
      .bindPopup(`<h4>${o.id}</h4>${esc(o.customerName)}<br>From ${esc(o.pickup.name)}<br>${o.priority === 'urgent' ? '<span class="badge urgent">Urgent</span>' : ''} ${o.coldChain ? '<span class="badge cold">Cold chain</span>' : ''}`)
      .addTo(pendingLayer);
  });

  // riders: smooth marker movement + remaining path
  const routesKey = STATE.riders.map(r => r.id + ':' + r.remainingPath.length).join('|');
  if (routesKey !== lastRoutesKey) {
    routeLayer.clearLayers();
    STATE.riders.forEach(r => r.remainingPath.forEach(p =>
      L.polyline(p, { color: riderColor(r.id), weight: 4, opacity: 0.8 }).addTo(routeLayer)));
    lastRoutesKey = routesKey;
    if (!STATE.riders.some(r => r.remainingPath.length)) stopLayer.clearLayers();
  }
  STATE.riders.forEach(r => {
    const pos = r.position;
    if (!riderMarkers[r.id]) {
      riderMarkers[r.id] = L.marker([pos.lat, pos.lng], { icon: riderIcon(riderColor(r.id)), zIndexOffset: 3000 }).addTo(riderLayer);
    } else slideMarker(riderMarkers[r.id], pos, 900);
    riderMarkers[r.id].bindPopup(`<h4>${esc(r.name)} (${r.id})</h4>${esc(r.vehicle)} · capacity ${r.capacity}<br>${r.upcoming ? r.upcoming + ' stops left' : 'Idle'}`);
  });

  riderList.innerHTML = STATE.riders.map(r => `<div class="item"><span class="swatch" style="background:${riderColor(r.id)}"></span>
    <div class="grow"><div class="title">${esc(r.name)} <span class="muted small">${r.id} · ${esc(r.vehicle)}</span></div></div>
    <span class="badge ${r.upcoming ? 'cold' : 'grey'}">${r.upcoming ? r.upcoming + ' stops left' : 'Idle'}</span></div>`).join('');
  orderList.innerHTML = STATE.orders.slice(0, 15).map(o => `<div class="item small"><div class="grow"><b>${o.id}</b> ${o.priority === 'urgent' ? '<span class="badge urgent">Urgent</span>' : ''}${o.coldChain ? ' <span class="badge cold">❄</span>' : ''}
      <div class="muted">${esc(o.customerName)} ← ${esc(o.pickup.name)}</div></div>
      <div style="text-align:right">${statusBadge(o.status)}${o.riderId ? `<div class="muted">${o.riderId}${o.etaMin != null && o.status !== 'delivered' ? ' · ' + o.etaMin + ' min' : ''}</div>` : ''}</div></div>`).join('') || '<div class="muted">No orders yet.</div>';

  renderResult(STATE.lastDispatch);
  renderLegend();
}

let lastResultAt = null;
function renderResult(d) {
  if (!d || d.at === lastResultAt) return;
  lastResultAt = d.at;
  const row = (label, a, b, unit = '', lowerBetter = true) => {
    const better = lowerBetter ? b < a : b > a;
    return `<tr><td>${label}</td><td>${a}${unit}</td><td class="${better ? 'good' : ''}">${b}${unit}</td></tr>`;
  };
  result.className = '';
  result.innerHTML = `
    <div class="muted small">${new Date(d.at).toLocaleTimeString()} · ${d.orderCount} orders · ${d.reason} · ${d.runtimeMs} ms · matrix: ${d.matrixSource}</div>
    <table class="compare" style="margin:.5rem 0">
      <tr><th></th><th>Naive FCFS</th><th>Optimised</th></tr>
      ${row('Total distance', d.baseline.km, d.optimised.km, ' km')}
      ${row('Rider time', d.baseline.riderMinutes, d.optimised.riderMinutes, ' min')}
      ${row('Avg delivery time', d.baseline.avgDeliveryMin, d.optimised.avgDeliveryMin, ' min')}
      ${row('Latest delivery', d.baseline.maxDeliveryMin, d.optimised.maxDeliveryMin, ' min')}
      ${row('Cold-chain violations', d.baseline.coldChainViolations, d.optimised.coldChainViolations)}
      ${row('Objective cost', d.baseline.cost, d.optimised.cost)}
    </table>
    <div class="stats">
      <div class="stat"><b style="color:var(--ok)">${d.savings.kmPct}%</b><span>distance saved</span></div>
      <div class="stat"><b style="color:var(--ok)">${d.savings.avgDeliveryPct}%</b><span>faster delivery</span></div>
      <div class="stat"><b style="color:var(--ok)">${d.savings.co2KgSaved} kg</b><span>CO₂ saved</span></div>
    </div>
    <label class="switch" style="margin-top:.5rem"><input type="checkbox" id="showNaive"> Show naive plan on map (dashed)</label>
    <div class="list" style="margin:.5rem 0">${d.routes.map(r => `<div class="item small"><span class="swatch" style="background:${riderColor(r.riderId)}"></span>
      <div class="grow"><b>${esc(r.riderName)}</b> · ${r.km} km · ${r.minutes} min
      <div class="muted">${r.stops.map(s => (s.type === 'pickup' ? '✚ ' : '⌂ ') + s.orderId.replace('ORD', '')).join(' → ')}</div></div></div>`).join('')}</div>
    <details><summary class="small">Optimiser log</summary><div class="log">${d.log.map(esc).join('\n')}</div></details>`;

  stopLayer.clearLayers();
  d.routes.forEach(r => r.stops.forEach((s, i) => L.marker([s.lat, s.lng], { icon: numberIcon(i + 1, riderColor(r.riderId)) })
    .bindTooltip(`${r.riderName} stop ${i + 1}: ${s.type === 'pickup' ? 'pick up' : 'deliver'} ${s.orderId}<br>${esc(s.label)}`).addTo(stopLayer)));
  naiveLayer.clearLayers();
  d.baselineRoutes.forEach(b => L.polyline(b.path, { color: riderColor(b.riderId), weight: 2, dashArray: '6 6', opacity: 0.7 }).addTo(naiveLayer));
  document.getElementById('showNaive').onchange = e => e.target.checked ? naiveLayer.addTo(map) : map.removeLayer(naiveLayer);
  if (d.routes.length) map.fitBounds(L.latLngBounds(d.routes.flatMap(r => r.stops.map(s => [s.lat, s.lng]))).pad(0.15));
}

function renderLegend() {
  const el = document.getElementById('legend');
  const riders = STATE.riders.map(r => `<div><i style="background:${riderColor(r.id)};border-radius:50%"></i>${esc(r.name)}</div>`).join('');
  el.innerHTML = `<b>Riders</b>${riders}<div style="margin-top:4px"><i style="background:#ff7a45;border-radius:50%"></i>Awaiting dispatch</div>
    <div><i style="background:#0f9d8a;border-radius:50%"></i>Pharmacy</div><div><i style="background:#7c3aed;border-radius:50%"></i>24×7 pharmacy</div>
    ${map.hasLayer(voronoiLayer) ? '<b style="display:block;margin-top:4px">Orders / territory</b>' + DEMAND_COLORS.map((c, i) => `<div><i style="background:${c}"></i>${DEMAND_LABELS[i]}</div>`).join('') : ''}
    ${map.hasLayer(coverageLayer) ? '<div style="margin-top:4px"><i style="background:#e5484d"></i>Not covered by 24×7</div>' : ''}`;
}

// ---------------- controls ----------------
autoDispatch.onchange = () => api('/api/admin/settings', { method: 'POST', body: { autoDispatch: autoDispatch.checked } });
simSpeed.onchange = async () => {
  const s = await api('/api/admin/settings', { method: 'POST', body: { simSpeed: +simSpeed.value } });
  if (s.simSpeed !== +simSpeed.value) toast('Speed can only change while all riders are idle');
};
genDemo.onclick = async () => {
  const r = await api('/api/admin/demo-orders', { method: 'POST', body: { count: +demoCount.value } });
  toast(`${r.created.length} demo orders created`);
  refresh();
};
runOpt.onclick = async () => {
  runOpt.disabled = true; runOpt.textContent = 'Optimising…';
  try { await api('/api/admin/dispatch', { method: 'POST' }); await refresh(); toast('Routes optimised and dispatched'); }
  catch (e) { toast(e.message); }
  finally { runOpt.disabled = false; runOpt.textContent = '⚡ Optimise & dispatch'; }
};
resetBtn.onclick = async () => {
  if (!confirm('Reset all orders, stock and riders?')) return;
  await api('/api/admin/reset', { method: 'POST' });
  location.reload();
};

// ---------------- GIS analysis ----------------
const DEMAND_COLORS = ['#fff5eb', '#fdd0a2', '#fd8d3c', '#d94801', '#7f2704'];
let DEMAND_LABELS = [];

gHeat.onchange = async () => {
  if (!gHeat.checked) { if (heatLayer) map.removeLayer(heatLayer); return; }
  const pts = await api('/api/geo/heatmap');
  if (heatLayer) map.removeLayer(heatLayer);
  heatLayer = L.heatLayer(pts, { radius: 22, blur: 18, maxZoom: 14, minOpacity: 0.3 }).addTo(map);
  gisInfo.textContent = `${pts.length} order locations in the heatmap.`;
};

gVoronoi.onchange = async () => {
  voronoiLayer.clearLayers();
  if (!gVoronoi.checked) { map.removeLayer(voronoiLayer); renderLegend(); return; }
  const pts = turf.featureCollection(PHARMACIES.map(p => turf.point([p.lng, p.lat], { id: p.id, name: p.name })));
  const cells = turf.voronoi(pts, { bbox: turf.bbox(SERVICE) });
  const demand = await api('/api/geo/heatmap');
  const demandPts = turf.featureCollection(demand.map(d => turf.point([d[1], d[0]])));
  const stats = [];
  cells.features.forEach((cell, i) => {
    if (!cell) return;
    let clipped;
    try { clipped = turf.intersect(cell, SERVICE); } catch { clipped = cell; }
    if (!clipped) return;
    const count = turf.pointsWithinPolygon(demandPts, clipped).features.length;
    const areaKm2 = turf.area(clipped) / 1e6;
    stats.push({ ph: PHARMACIES[i], count, areaKm2, shape: clipped });
  });
  const max = Math.max(...stats.map(s => s.count));
  const step = Math.ceil(max / 5);
  DEMAND_LABELS = DEMAND_COLORS.map((_, i) => `${i * step}–${(i + 1) * step}`);
  stats.forEach(s => {
    const color = DEMAND_COLORS[Math.min(4, Math.floor(s.count / step))];
    L.geoJSON(s.shape, { style: { color: '#7f2704', weight: 1, fillColor: color, fillOpacity: 0.55 } })
      .bindTooltip(`<b>${esc(s.ph.name)}</b><br>Territory ${s.areaKm2.toFixed(1)} km²<br>${s.count} orders (${(s.count / s.areaKm2).toFixed(1)}/km²)`, { sticky: true })
      .addTo(voronoiLayer);
  });
  voronoiLayer.addTo(map);
  pharmacyLayer.bringToFront?.();
  stats.sort((a, b) => b.count - a.count);
  territoryStats.className = 'small';
  territoryStats.innerHTML = `<table class="compare"><tr><th>Pharmacy</th><th>km²</th><th>Orders</th><th>per km²</th></tr>
    ${stats.map(s => `<tr><td>${esc(s.ph.area)}</td><td>${s.areaKm2.toFixed(1)}</td><td>${s.count}</td><td>${(s.count / s.areaKm2).toFixed(1)}</td></tr>`).join('')}</table>
    <div class="muted" style="margin-top:.4rem">High orders-per-km² with a large territory suggests where a new partner pharmacy would help most.</div>`;
  renderLegend();
};

gCoverage.onchange = () => {
  coverageLayer.clearLayers();
  if (!gCoverage.checked) { map.removeLayer(coverageLayer); renderLegend(); return; }
  const open = PHARMACIES.filter(p => p.open24);
  let union = null;
  open.forEach(p => {
    const b = turf.buffer(turf.point([p.lng, p.lat]), 2.5, { units: 'kilometers', steps: 48 });
    union = union ? turf.union(union, b) : b;
  });
  const gap = turf.difference(SERVICE, union);
  L.geoJSON(union, { style: { color: '#7c3aed', weight: 1, fillColor: '#7c3aed', fillOpacity: 0.12 } }).addTo(coverageLayer);
  if (gap) L.geoJSON(gap, { style: { color: '#e5484d', weight: 1, fillColor: '#e5484d', fillOpacity: 0.3 } })
    .bindTooltip('Not within 2.5 km of a 24×7 pharmacy', { sticky: true }).addTo(coverageLayer);
  coverageLayer.addTo(map);
  const total = turf.area(SERVICE), uncovered = gap ? turf.area(gap) : 0;
  gisInfo.innerHTML = `<b>${open.length}</b> 24×7 pharmacies cover <b>${(((total - uncovered) / total) * 100).toFixed(1)}%</b> of the service area
    (${((total - uncovered) / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} km²). Red = night-time coverage gaps.`;
  renderLegend();
};

gNearest.onchange = () => { nearestLayer.clearLayers(); map.getContainer().style.cursor = gNearest.checked ? 'crosshair' : ''; };
map.on('click', e => {
  if (!gNearest.checked) return;
  nearestLayer.clearLayers();
  const here = turf.point([e.latlng.lng, e.latlng.lat]);
  const inside = turf.booleanPointInPolygon(here, SERVICE);
  const ranked = PHARMACIES.map(p => ({ p, d: turf.distance(here, [p.lng, p.lat]) })).sort((a, b) => a.d - b.d).slice(0, 3);
  L.marker(e.latlng, { icon: pinIcon('home', '◎', 24) }).addTo(nearestLayer);
  ranked.forEach((r, i) => L.polyline([e.latlng, [r.p.lat, r.p.lng]], { color: ['#1a9850', '#fd8d3c', '#e5484d'][i], weight: 3, dashArray: '5 5' })
    .bindTooltip(`#${i + 1} ${esc(r.p.name)} – ${r.d.toFixed(2)} km`, { permanent: i === 0 }).addTo(nearestLayer));
  gisInfo.innerHTML = `${inside ? '' : '<span class="badge rx">Outside service area</span> '}Nearest: ${ranked.map((r, i) => `${i + 1}. ${esc(r.p.name)} (${r.d.toFixed(2)} km)`).join(', ')}`;
});

const ISO_BREAKS = [0, 5, 10, 15, 20, 30];
const ISO_COLORS = ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#fc8d59'];
isoBtn.onclick = async () => {
  isoLayer.clearLayers();
  isoInfo.textContent = 'Computing travel times…';
  const grid = await api(`/api/geo/isochrone?pharmacyId=${isoPharmacy.value}&radiusKm=8&cellKm=0.7`);
  const fc = turf.featureCollection(grid.points.map(p => turf.point([p.lng, p.lat], { min: p.min })));
  const bands = turf.isobands(fc, ISO_BREAKS, { zProperty: 'min' });
  const rows = [];
  bands.features.forEach((f, i) => {
    let shape = f;
    try { shape = turf.intersect(f, SERVICE) || null; } catch {}
    if (!shape) return;
    rows.push(`<span class="swatch" style="background:${ISO_COLORS[i]}"></span>${ISO_BREAKS[i]}–${ISO_BREAKS[i + 1]} min: ${(turf.area(shape) / 1e6).toFixed(1)} km²`);
    L.geoJSON(shape, { style: { weight: 0, fillColor: ISO_COLORS[i], fillOpacity: 0.45 } })
      .bindTooltip(`${ISO_BREAKS[i]}–${ISO_BREAKS[i + 1]} min from ${esc(grid.pharmacy.name)}`, { sticky: true }).addTo(isoLayer);
  });
  L.marker([grid.pharmacy.lat, grid.pharmacy.lng], { icon: pinIcon('pharmacy', '✚', 30) }).addTo(isoLayer);
  map.setView([grid.pharmacy.lat, grid.pharmacy.lng], 12);
  isoInfo.innerHTML = rows.join('<br>') + `<div class="muted">${grid.points.length} grid points · ${grid.source}</div>`;
};
isoClear.onclick = () => { isoLayer.clearLayers(); isoInfo.textContent = ''; };

// ---------------- benchmark ----------------
benchBtn.onclick = async () => {
  benchBtn.disabled = true;
  benchOut.innerHTML = '<div class="muted small">Solving…</div>';
  try {
    const b = await api('/api/admin/benchmark', { method: 'POST', body: { n: +benchN.value } });
    benchOut.innerHTML = `<table class="compare">
      <tr><th>Method</th><th>Route time</th><th>Runtime</th></tr>
      <tr><td>Exact (Held-Karp DP)</td><td>${b.exactMinutes} min</td><td>${b.exactMs} ms</td></tr>
      <tr><td>Heuristic (regret + SA + polish)</td><td>${b.heuristicMinutes} min</td><td>${b.heuristicMs} ms</td></tr>
      <tr><td>Naive FCFS</td><td>${b.naiveMinutes} min</td><td>–</td></tr></table>
      <div class="stats" style="margin-top:.5rem">
        <div class="stat"><b style="color:${b.gapPct < 1 ? 'var(--ok)' : 'var(--warn)'}">${b.gapPct}%</b><span>optimality gap</span></div>
        <div class="stat"><b>${(((b.naiveMinutes - b.heuristicMinutes) / b.naiveMinutes) * 100).toFixed(1)}%</b><span>better than naive</span></div>
        <div class="stat"><b>${b.dpStates.toLocaleString()}</b><span>DP states</span></div></div>
      <div class="muted small" style="margin-top:.4rem">Matrix: ${b.matrixSource}. The exact DP grows exponentially (7 orders = 14 stops ≈ 230k states); the heuristic scales to large batches.</div>`;
    // draw the instance
    isoLayer.clearLayers();
    const pts = [[b.rider.lat, b.rider.lng], ...b.orders.flatMap(o => [[o.pickup.lat, o.pickup.lng], [o.drop.lat, o.drop.lng]])];
    const nodeLL = n => pts[n]; // node 0 = rider, then pickup/drop pairs
    L.polyline([nodeLL(0), ...b.exactRoute.map(nodeLL)], { color: '#1d4ed8', weight: 4 }).bindTooltip('Exact optimal route').addTo(isoLayer);
    L.polyline([nodeLL(0), ...b.heuristicRoute.map(nodeLL)], { color: '#ff7a45', weight: 2, dashArray: '6 6' }).bindTooltip('Heuristic route').addTo(isoLayer);
    L.marker(nodeLL(0), { icon: riderIcon('#1d4ed8') }).addTo(isoLayer);
    b.orders.forEach((o, i) => {
      L.marker([o.pickup.lat, o.pickup.lng], { icon: pinIcon('pharmacy', 'P' + (i + 1), 24) }).addTo(isoLayer);
      L.marker([o.drop.lat, o.drop.lng], { icon: pinIcon('drop', 'D' + (i + 1), 24) }).addTo(isoLayer);
    });
    map.fitBounds(L.latLngBounds(pts).pad(0.2));
  } catch (e) { benchOut.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  benchBtn.disabled = false;
};

// ---------------- tabs ----------------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
});

init().catch(e => toast(e.message));
