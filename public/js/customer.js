const user = Auth.require('customer');
renderTopbar(user);

const S = {
  meds: [], pharmacies: [], cart: new Map(), category: 'All',
  loc: null, inside: false, priority: 'normal',
  ranked: [], selectedPh: null, rxFile: null, rxResult: null, ocrBusy: false, serviceArea: null
};

// ---------------- map & GIS layers ----------------
const { map, layerControl } = createMap('map', { zoom: 12 });
const pharmacyCluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 });
const open24Layer = L.layerGroup();
const bufferLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const isoLayer = L.layerGroup();
layerControl.addOverlay(pharmacyCluster, 'Pharmacies (clustered)');
layerControl.addOverlay(open24Layer, '24×7 pharmacies only');
layerControl.addOverlay(bufferLayer, '3 km radius buffer');
layerControl.addOverlay(routeLayer, 'Pharmacy → you route');
layerControl.addOverlay(isoLayer, 'Delivery-time zones (isochrones)');
map.addLayer(pharmacyCluster);

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const d = L.DomUtil.create('div', 'map-legend');
  d.innerHTML = `<div><i style="background:#0f9d8a;border-radius:50%"></i>Pharmacy</div>
    <div><i style="background:#7c3aed;border-radius:50%"></i>Pharmacy (24×7)</div>
    <div><i style="background:#ff7a45;border-radius:50%"></i>Your delivery point</div>
    <div><i style="border:2px dashed #0f9d8a;background:none"></i>Service area</div>`;
  return d;
};
legend.addTo(map);

const dropMarker = L.marker(CHENNAI, { draggable: true, icon: pinIcon('drop', '⌂', 32), zIndexOffset: 1000 });
dropMarker.on('dragend', () => { const p = dropMarker.getLatLng(); setLocation(p.lat, p.lng); });
map.on('click', e => setLocation(e.latlng.lat, e.latlng.lng));

async function init() {
  const [meds, phs, area] = await Promise.all([
    api('/api/medicines'), api('/api/pharmacies'), addServiceArea(map, layerControl)
  ]);
  S.meds = meds; S.pharmacies = phs; S.serviceArea = area.geo;
  phs.forEach(p => {
    const m = L.marker([p.lat, p.lng], { icon: pinIcon('pharmacy', '✚', 26, p.open24 ? 'open24' : '') }).bindPopup(pharmacyPopup(p));
    pharmacyCluster.addLayer(m);
    if (p.open24) L.marker([p.lat, p.lng], { icon: pinIcon('pharmacy', '✚', 26, 'open24') }).bindPopup(pharmacyPopup(p)).addTo(open24Layer);
  });
  renderCategories();
  renderMeds();
  setLocation(13.0335, 80.2470, 'Nandanam, Chennai (default — click the map to change)');
  renderOrders();
}

// ---------------- delivery location ----------------
async function setLocation(lat, lng, address) {
  S.loc = { lat, lng, address: address || `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  dropMarker.setLatLng([lat, lng]).addTo(map);
  S.inside = turf.booleanPointInPolygon(turf.point([lng, lat]), S.serviceArea);

  // 3 km buffer + pharmacies inside it (Turf.js spatial query)
  bufferLayer.clearLayers();
  const circle = turf.circle([lng, lat], 3, { units: 'kilometers', steps: 64 });
  L.geoJSON(circle, { style: { color: '#ff7a45', weight: 1, fillOpacity: 0.06, dashArray: '4 4' }, interactive: false }).addTo(bufferLayer);
  const pts = turf.featureCollection(S.pharmacies.map(p => turf.point([p.lng, p.lat], { id: p.id })));
  const near = turf.pointsWithinPolygon(pts, circle).features.length;
  const nearest = S.pharmacies.map(p => ({ p, d: turf.distance([lng, lat], [p.lng, p.lat]) })).sort((a, b) => a.d - b.d)[0];

  locText.textContent = S.loc.address;
  locStatus.innerHTML = S.inside
    ? `<span class="badge ok">Inside service area</span> ${near} pharmacies within 3 km · nearest ${nearest.d.toFixed(1)} km (${esc(nearest.p.area)})`
    : `<span class="badge rx">Outside service area</span> We currently deliver only within Chennai.`;

  if (!address) reverseGeocode(lat, lng);
  refreshCheckout();
}

let geoTimer;
function reverseGeocode(lat, lng) {
  clearTimeout(geoTimer);
  geoTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17`).then(r => r.json());
      if (r.display_name && S.loc && S.loc.lat === lat) {
        S.loc.address = r.display_name.split(',').slice(0, 4).join(',');
        locText.textContent = S.loc.address;
      }
    } catch {}
  }, 600);
}

let searchTimer;
addrSearch.oninput = () => {
  clearTimeout(searchTimer);
  const q = addrSearch.value.trim();
  if (q.length < 3) { addrResults.classList.add('hidden'); return; }
  searchTimer = setTimeout(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=in&viewbox=80.08,13.23,80.33,12.82&bounded=1&q=${encodeURIComponent(q)}`;
      const res = await fetch(url).then(r => r.json());
      addrResults.innerHTML = res.length ? res.map((r, i) => `<div data-i="${i}">${esc(r.display_name)}</div>`).join('') : '<div>No results in Chennai</div>';
      addrResults.classList.remove('hidden');
      addrResults.querySelectorAll('[data-i]').forEach(el => el.onclick = () => {
        const r = res[+el.dataset.i];
        addrResults.classList.add('hidden');
        addrSearch.value = '';
        map.setView([+r.lat, +r.lon], 15);
        setLocation(+r.lat, +r.lon, r.display_name.split(',').slice(0, 4).join(','));
      });
    } catch { toast('Address search unavailable'); }
  }, 450);
};

locateBtn.onclick = () => {
  if (!navigator.geolocation) return toast('Geolocation not supported');
  navigator.geolocation.getCurrentPosition(
    p => { map.setView([p.coords.latitude, p.coords.longitude], 15); setLocation(p.coords.latitude, p.coords.longitude); },
    () => toast('Could not get your location'), { enableHighAccuracy: true, timeout: 8000 });
};

// ---------------- medicines ----------------
function renderCategories() {
  const cats = ['All', ...new Set(S.meds.map(m => m.category))];
  catChips.innerHTML = cats.map(c => `<button class="chip ${c === S.category ? 'active' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  catChips.querySelectorAll('.chip').forEach(b => b.onclick = () => { S.category = b.dataset.c; renderCategories(); renderMeds(); });
}

function renderMeds() {
  const q = medSearch.value.trim().toLowerCase();
  const list = S.meds.filter(m => (S.category === 'All' || m.category === S.category) &&
    (!q || m.name.toLowerCase().includes(q) || m.generic.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)));
  medList.innerHTML = list.map(m => {
    const qty = S.cart.get(m.id) || 0;
    return `<div class="item">
      <div class="grow">
        <div class="title">${esc(m.name)}</div>
        <div class="muted small">${esc(m.generic)} · ${esc(m.pack)} · in ${m.availableAt} stores</div>
        <div>${m.rx ? '<span class="badge rx">Rx required</span>' : ''} ${m.coldChain ? '<span class="badge cold">❄ Cold chain</span>' : ''}</div>
      </div>
      <div style="text-align:right">
        <div class="price">${rupee(m.price)}</div>
        ${qty ? qtyControl(m.id, qty) : `<button class="btn sm primary" data-add="${m.id}">Add</button>`}
      </div></div>`;
  }).join('') || '<div class="muted">No medicines match.</div>';
  bindQty(medList);
}
medSearch.oninput = renderMeds;

const qtyControl = (id, q) => `<div class="qty"><button data-dec="${id}">−</button><b>${q}</b><button data-inc="${id}">+</button></div>`;
function bindQty(root) {
  root.querySelectorAll('[data-add]').forEach(b => b.onclick = () => changeQty(b.dataset.add, 1));
  root.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => changeQty(b.dataset.inc, 1));
  root.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => changeQty(b.dataset.dec, -1));
}
function changeQty(id, d) {
  const q = Math.max(0, Math.min(10, (S.cart.get(id) || 0) + d));
  if (q) S.cart.set(id, q); else S.cart.delete(id);
  renderMeds(); renderCart(); refreshCheckout();
}

// ---------------- cart & checkout ----------------
const cartItems = () => [...S.cart].map(([medId, qty]) => ({ medId, qty, med: S.meds.find(m => m.id === medId) }));
const rxItems = () => cartItems().filter(i => i.med.rx);

function renderCart() {
  const items = cartItems();
  cartCount.textContent = items.reduce((s, i) => s + i.qty, 0);
  cartCount.classList.toggle('hidden', !items.length);
  cartEmpty.classList.toggle('hidden', !!items.length);
  checkout.classList.toggle('hidden', !items.length);
  cartList.innerHTML = items.map(i => `<div class="item"><div class="grow"><div class="title">${esc(i.med.name)}</div>
      <div>${i.med.rx ? '<span class="badge rx">Rx</span>' : ''} ${i.med.coldChain ? '<span class="badge cold">❄</span>' : ''}
      <span class="muted small">${rupee(i.med.price)} each</span></div></div>
      ${qtyControl(i.medId, i.qty)}<div class="price" style="width:60px;text-align:right">${rupee(i.med.price * i.qty)}</div></div>`).join('');
  bindQty(cartList);
  const rx = rxItems();
  rxSection.classList.toggle('hidden', !rx.length);
  rxMeds.textContent = rx.length ? 'Needed for: ' + rx.map(i => i.med.name).join(', ') : '';
  updateBill();
}

document.querySelectorAll('[data-priority]').forEach(b => b.onclick = () => {
  S.priority = b.dataset.priority;
  document.querySelectorAll('[data-priority]').forEach(x => x.classList.toggle('active', x === b));
  updateBill();
});

let rankSeq = 0;
async function refreshCheckout() {
  const items = cartItems();
  if (!items.length || !S.loc) { routeLayer.clearLayers(); return; }
  if (!S.inside) {
    phRank.innerHTML = '<div class="error">Delivery location is outside the service area.</div>';
    S.ranked = []; S.selectedPh = null; updateBill(); return;
  }
  const seq = ++rankSeq;
  phRank.innerHTML = '<div class="muted">Finding pharmacies with all items in stock…</div>';
  try {
    const ranked = await api('/api/pharmacies/best', { method: 'POST', body: { lat: S.loc.lat, lng: S.loc.lng, items: items.map(i => ({ medId: i.medId, qty: i.qty })) } });
    if (seq !== rankSeq) return;
    S.ranked = ranked;
    if (!S.selectedPh || !ranked.some(r => r.id === S.selectedPh)) S.selectedPh = ranked[0].id;
    renderRanking();
  } catch (e) {
    if (seq !== rankSeq) return;
    S.ranked = []; S.selectedPh = null;
    phRank.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    routeLayer.clearLayers();
  }
  updateBill();
}

function renderRanking() {
  phRank.innerHTML = S.ranked.map((r, i) => `<div class="item clickable ${r.id === S.selectedPh ? 'selected' : ''}" data-ph="${r.id}">
      <div class="grow"><div class="title">${i === 0 ? '⭐ ' : ''}${esc(r.name)}</div>
      <div class="muted small">${r.roadKm} km by road (${r.straightKm} km straight) · ~${r.etaMin} min ${r.open24 ? '· 24×7' : ''}</div></div>
    </div>`).join('');
  phRank.querySelectorAll('[data-ph]').forEach(el => el.onclick = () => { S.selectedPh = el.dataset.ph; renderRanking(); updateBill(); });
  drawRoutePreview();
}

async function drawRoutePreview() {
  routeLayer.clearLayers();
  isoLayer.clearLayers();
  const ph = S.ranked.find(r => r.id === S.selectedPh);
  if (!ph) return;
  const r = await api(`/api/geo/route?from=${ph.lat},${ph.lng}&to=${S.loc.lat},${S.loc.lng}`);
  L.polyline(r.path, { color: '#0f9d8a', weight: 5, opacity: 0.85 }).addTo(routeLayer);
  L.marker([ph.lat, ph.lng], { icon: pinIcon('pharmacy', '✚', 32) }).bindPopup(`<h4>${esc(ph.name)}</h4>Selected pharmacy`).addTo(routeLayer);
  map.fitBounds(L.latLngBounds([...r.path, [S.loc.lat, S.loc.lng]]).pad(0.3), { maxZoom: 15 });
  if (map.hasLayer(isoLayer)) drawIsochrone(ph.id);
}

// Isochrones: travel-time grid from the server, contoured with Turf isobands
const ISO_BREAKS = [0, 5, 10, 15, 20, 30];
const ISO_COLORS = ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#fc8d59'];
async function drawIsochrone(pharmacyId) {
  isoLayer.clearLayers();
  const grid = await api(`/api/geo/isochrone?pharmacyId=${pharmacyId}&radiusKm=7&cellKm=0.7`);
  const fc = turf.featureCollection(grid.points.map(p => turf.point([p.lng, p.lat], { min: p.min })));
  const bands = turf.isobands(fc, ISO_BREAKS, { zProperty: 'min', breaksProperties: ISO_COLORS.map((c, i) => ({ fill: c, label: `${ISO_BREAKS[i]}–${ISO_BREAKS[i + 1]} min` })) });
  bands.features.forEach(f => {
    let shape = f;
    try { shape = turf.intersect(f, S.serviceArea) || f; } catch {}
    L.geoJSON(shape, { style: { color: f.properties.fill, weight: 0, fillColor: f.properties.fill, fillOpacity: 0.35 } })
      .bindTooltip(`${f.properties.label} ride from ${esc(grid.pharmacy.name)}`, { sticky: true }).addTo(isoLayer);
  });
}
map.on('overlayadd', e => { if (e.layer === isoLayer && S.selectedPh) drawIsochrone(S.selectedPh); });

function updateBill() {
  const items = cartItems();
  const sub = items.reduce((s, i) => s + i.med.price * i.qty, 0);
  const ph = S.ranked.find(r => r.id === S.selectedPh);
  const fee = ph ? Math.round(20 + 6 * ph.roadKm + (S.priority === 'urgent' ? 40 : 0)) : null;
  billItems.textContent = rupee(sub);
  billFee.textContent = fee == null ? '–' : rupee(fee);
  billKm.textContent = ph ? `(${ph.roadKm} km)` : '';
  billTotal.textContent = rupee(sub + (fee || 0));
  const needRx = rxItems().length > 0;
  placeOrder.disabled = !items.length || !ph || !S.inside || S.ocrBusy || (needRx && !S.rxResult);
  placeOrder.textContent = needRx && !S.rxResult ? 'Upload prescription to continue' : 'Place order';
}

// ---------------- prescription upload + OCR ----------------
rxFile.onchange = () => rxFile.files[0] && handleRxFile(rxFile.files[0]);
['dragover', 'dragenter'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', e => e.dataTransfer.files[0] && handleRxFile(e.dataTransfer.files[0]));
sampleGood.onclick = async () => handleRxFile(await Rx.generateSample({ patient: user.name, medicines: rxItems().map(i => i.med), quality: 'good' }));
samplePoor.onclick = async () => handleRxFile(await Rx.generateSample({ patient: user.name, medicines: rxItems().map(i => i.med), quality: 'poor' }));

async function handleRxFile(file) {
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) return toast('Please choose a PDF, JPG or PNG file');
  if (file.size > 5 * 1024 * 1024) return toast('File is larger than 5 MB');
  S.rxFile = file; S.rxResult = null; S.ocrBusy = true;
  rxFileName.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  if (file.type.startsWith('image/')) { rxPreview.src = URL.createObjectURL(file); rxPreview.classList.remove('hidden'); }
  else rxPreview.classList.add('hidden');
  ocrBox.classList.remove('hidden');
  ocrText.textContent = '';
  updateBill();
  try {
    const res = await Rx.extract(file, (p, msg) => {
      ocrBar.style.width = Math.round(p * 100) + '%';
      ocrStatus.textContent = `${msg}… ${Math.round(p * 100)}%`;
    });
    S.rxResult = res;
    ocrBar.style.width = '100%';
    const words = res.text.split(/\s+/).filter(w => w.length > 2).length;
    ocrStatus.innerHTML = `✅ Text extracted (${words} words${res.blurScore != null ? `, sharpness ${res.blurScore.toFixed(0)}` : ''}). Final screening happens after you place the order.`;
    ocrText.textContent = res.text;
  } catch (e) {
    ocrStatus.innerHTML = `<span class="error">Could not read the file: ${esc(e.message)}</span>`;
    S.rxResult = { text: '', blurScore: null };
  } finally {
    S.ocrBusy = false;
    updateBill();
  }
}

placeOrder.onclick = async () => {
  orderError.textContent = '';
  placeOrder.disabled = true;
  try {
    const fd = new FormData();
    fd.append('data', JSON.stringify({
      lat: S.loc.lat, lng: S.loc.lng, address: S.loc.address, priority: S.priority, pharmacyId: S.selectedPh,
      payment: payment.value, items: cartItems().map(i => ({ medId: i.medId, qty: i.qty }))
    }));
    if (rxItems().length) {
      fd.append('ocrText', S.rxResult.text || '');
      fd.append('blurScore', S.rxResult.blurScore == null ? '' : String(S.rxResult.blurScore));
      fd.append('prescription', S.rxFile, S.rxFile.name);
    }
    const order = await api('/api/orders', { method: 'POST', body: fd });
    location.href = `/order.html?id=${order.id}`;
  } catch (e) {
    orderError.textContent = e.message;
    updateBill();
  }
};

// ---------------- orders ----------------
async function renderOrders() {
  const orders = await api('/api/orders/mine');
  orderList.innerHTML = orders.length ? orders.map(o => `<a class="item clickable" href="/order.html?id=${o.id}" style="text-decoration:none;color:inherit">
      <div class="grow"><div class="title">${o.id}</div><div class="muted small">${esc(o.pharmacy)} · ${o.items} item(s) · ${new Date(o.createdAt).toLocaleString()}</div></div>
      <div style="text-align:right">${statusBadge(o.status)}<div class="price small" style="margin-top:4px">${rupee(o.total)}</div></div></a>`).join('')
    : '<div class="muted">No orders yet.</div>';
}

// ---------------- tabs ----------------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
  if (b.dataset.tab === 'orders') renderOrders();
});

init().catch(e => toast(e.message));
