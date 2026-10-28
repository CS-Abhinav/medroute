// Order status page: "waiting for approval" screen during screening/review,
// then live tracking once a rider is assigned.
const user = Auth.require('customer', 'admin', 'pharmacist');
renderTopbar(user);
const orderId = new URLSearchParams(location.search).get('id');

const { map, layerControl } = createMap('map', { zoom: 13 });
const routeLayer = L.layerGroup().addTo(map);
setTimeout(() => map.invalidateSize(), 300);
let riderMarker = null, fitted = false, order = null, lastRouteKey = '', lastStageKey = '';
let pharmacyMarker, dropMarker;

const FLOW = ['placed', 'screening', 'pending_review', 'approved', 'assigned', 'picked_up', 'delivered'];
const FLOW_TEXT = {
  placed: 'Order placed', screening: 'Automated prescription screening', pending_review: 'Pharmacist review',
  approved: 'Approved – finding the best rider', assigned: 'Rider heading to pharmacy',
  picked_up: 'Picked up – on the way to you', delivered: 'Delivered'
};

function renderTimeline(o) {
  const reached = new Set(o.statusHistory.map(h => h.status));
  const steps = FLOW.filter(s => (s !== 'screening' && s !== 'pending_review') || o.rxRequired)
    .filter(s => s !== 'pending_review' || reached.has('pending_review') || ['screening', 'placed'].includes(o.status));
  const failed = ['rejected', 'cancelled'].includes(o.status);
  timeline.innerHTML = steps.map(s => {
    const h = [...o.statusHistory].reverse().find(x => x.status === s);
    const cls = s === o.status ? (s === 'delivered' ? 'done' : 'active') : reached.has(s) ? 'done' : '';
    return `<li class="${cls}"><b>${FLOW_TEXT[s]}</b>${h ? `<div class="muted small">${timeStr(h.at)} · ${esc(h.note || '')}</div>` : ''}</li>`;
  }).join('') + (failed ? `<li class="failed"><b>${STATUS_LABEL[o.status]}</b><div class="muted small">${esc(o.rejectionReason || '')}</div></li>` : '');
}

function screeningHtml(sc) {
  if (!sc) return '';
  const color = sc.score >= 80 ? 'var(--ok)' : sc.score >= 45 ? 'var(--warn)' : 'var(--danger)';
  return `<div class="score-ring" style="--p:${sc.score};--c:${color}"><span>${sc.score}</span></div>
    <div class="muted small" style="text-align:center">Screening score / 100</div>
    <div class="checks">${sc.checks.map(c => `<div class="check"><span class="ic">${c.pass >= 1 ? '✅' : c.pass > 0 ? '⚠️' : '❌'}</span>
      <div><div>${esc(c.name)}</div><div class="detail">${esc(c.detail)}</div></div></div>`).join('')}</div>`;
}

function renderStage(o) {
  const sc = o.prescription && o.prescription.screening;
  let html = '';
  switch (o.status) {
    case 'placed':
    case 'screening':
      html = `<div class="waiting"><div class="spinner"></div><h3>Checking your prescription…</h3>
        <p class="muted">We're reading the document and checking the doctor's details, date, patient name and medicines. This takes a few seconds.</p></div>`;
      break;
    case 'pending_review':
      html = `<div class="waiting"><div class="spinner"></div><h3>Waiting for pharmacist approval</h3>
        <p class="muted">${esc(sc.summary)} You'll see the update here automatically.</p></div>${screeningHtml(sc)}`;
      break;
    case 'rejected':
      html = `<div class="waiting"><div style="font-size:48px">⚠️</div><h3>Prescription not accepted</h3>
        <p class="muted">${esc(o.rejectionReason || '')}</p>
        <div class="row" style="justify-content:center">
          <button class="btn primary" id="reupload">Upload a new prescription</button>
          <button class="btn" id="cancelBtn">Cancel order</button></div>
        <div class="small" id="reStatus" style="margin-top:.5rem"></div></div>${screeningHtml(sc)}`;
      break;
    case 'approved':
      html = `<div class="waiting"><div class="spinner"></div><h3>Order approved ✅</h3>
        <p class="muted">${o.approvedBy ? 'Approved by ' + esc(o.approvedBy) + '. ' : ''}Batching nearby orders and optimising rider routes…</p></div>
        ${sc ? `<details><summary class="small muted">Screening report</summary>${screeningHtml(sc)}</details>` : ''}`;
      break;
    case 'assigned':
    case 'picked_up':
      html = `<div style="text-align:center"><div class="muted">${o.status === 'assigned' ? 'Rider is collecting your medicines from' : 'On the way from'} ${esc(o.pickup.name)}</div>
        <div class="eta-big">${o.etaMin ?? '–'} min</div>
        <div class="muted small">estimated arrival (simulated time · ~${o.etaRealSec}s real)</div>
        <div style="margin-top:.6rem">🛵 <b>${esc(o.rider.name)}</b> · ${esc(o.rider.vehicle)} · ${o.rider.id}</div></div>`;
      break;
    case 'delivered':
      html = `<div class="waiting"><div style="font-size:48px">🎉</div><h3>Delivered!</h3><p class="muted">Get well soon. Thank you for ordering with MedRoute.</p></div>`;
      break;
    case 'cancelled':
      html = `<div class="waiting"><h3>Order cancelled</h3></div>`;
  }
  stageCard.innerHTML = html;
  const re = document.getElementById('reupload');
  if (re) re.onclick = () => reFile.click();
  const cb = document.getElementById('cancelBtn');
  if (cb) cb.onclick = async () => { await api(`/api/orders/${o.id}/cancel`, { method: 'POST' }); poll(); };
}

reFile.onchange = async () => {
  const file = reFile.files[0];
  if (!file) return;
  const st = document.getElementById('reStatus');
  try {
    const res = await Rx.extract(file, (p, msg) => { st.textContent = `${msg}… ${Math.round(p * 100)}%`; });
    const fd = new FormData();
    fd.append('ocrText', res.text || '');
    fd.append('blurScore', res.blurScore == null ? '' : String(res.blurScore));
    fd.append('prescription', file, file.name);
    await api(`/api/orders/${orderId}/prescription`, { method: 'POST', body: fd });
    poll();
  } catch (e) { st.textContent = e.message; }
};

function renderDetails(o) {
  details.innerHTML = o.items.map(i => `<div class="kv"><span>${esc(i.name)} × ${i.qty} ${i.rx ? '<span class="badge rx">Rx</span>' : ''}</span><span>${rupee(i.price * i.qty)}</span></div>`).join('') +
    `<div class="kv"><span>Delivery (${o.roadKm} km${o.priority === 'urgent' ? ', urgent' : ''})</span><span>${rupee(o.deliveryFee)}</span></div>
     <div class="kv total"><span>Total · ${esc(o.payment)}</span><span>${rupee(o.total)}</span></div>
     <div class="muted small" style="margin-top:.5rem">From <b>${esc(o.pickup.name)}</b><br>To ${esc(o.drop.address)}</div>
     ${o.prescription ? `<div class="small" style="margin-top:.5rem"><a target="_blank" href="${o.prescription.url}?token=${Auth.token}">View uploaded prescription</a></div>` : ''}`;
}

function renderMap(o) {
  if (!pharmacyMarker) {
    pharmacyMarker = L.marker([o.pickup.lat, o.pickup.lng], { icon: pinIcon('pharmacy', '✚', 30) }).bindPopup(esc(o.pickup.name)).addTo(map);
    dropMarker = L.marker([o.drop.lat, o.drop.lng], { icon: pinIcon('drop', '⌂', 30) }).bindPopup('Delivery point').addTo(map);
  }
  if (o.rider && ['assigned', 'picked_up'].includes(o.status)) {
    const key = JSON.stringify(o.riderPath.map(p => p.length));
    if (key !== lastRouteKey) {
      routeLayer.clearLayers();
      o.riderPath.forEach(p => L.polyline(p, { color: riderColor(o.rider.id), weight: 5, opacity: .8 }).addTo(routeLayer));
      lastRouteKey = key;
    }
    const pos = o.rider.position;
    if (!riderMarker) riderMarker = L.marker([pos.lat, pos.lng], { icon: riderIcon(riderColor(o.rider.id)), zIndexOffset: 2000 })
      .bindPopup(`${esc(o.rider.name)} (${o.rider.id})`).addTo(map);
    else slideMarker(riderMarker, pos, 900);
    if (!fitted) { map.fitBounds(L.latLngBounds([[pos.lat, pos.lng], [o.pickup.lat, o.pickup.lng], [o.drop.lat, o.drop.lng]]).pad(0.25), { maxZoom: 15 }); fitted = true; }
  } else {
    routeLayer.clearLayers(); lastRouteKey = '';
    if (riderMarker && o.status === 'delivered') { riderMarker.setLatLng([o.drop.lat, o.drop.lng]); }
    if (!fitted) { map.fitBounds(L.latLngBounds([[o.pickup.lat, o.pickup.lng], [o.drop.lat, o.drop.lng]]).pad(0.4), { maxZoom: 15 }); fitted = true; }
  }
}

async function poll() {
  try {
    order = await api('/api/orders/' + orderId);
    orderTitle.textContent = order.id;
    orderStatus.innerHTML = statusBadge(order.status);
    // Only rebuild the stage card when something visible changed (keeps re-upload progress text intact)
    const stageKey = [order.status, order.etaMin, order.rider && order.rider.id, order.prescription && order.prescription.screening && order.prescription.screening.screenedAt].join('|');
    if (stageKey !== lastStageKey) { renderStage(order); lastStageKey = stageKey; }
    renderTimeline(order); renderDetails(order); renderMap(order);
  } catch (e) { stageCard.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
poll();
setInterval(() => { if (!order || !['delivered', 'cancelled'].includes(order.status)) poll(); }, 1000);
