const user = Auth.require('rider');
renderTopbar(user);
const { map } = createMap('map', { zoom: 12 });
const pathLayer = L.layerGroup().addTo(map), stopLayer = L.layerGroup().addTo(map);
let me = null, lastKey = '', fitted = false;

async function poll() {
  const d = await api('/api/rider/me');
  const color = riderColor(d.rider.id);
  riderTitle.textContent = `${d.rider.name} · ${d.rider.id}`;
  const upcoming = d.stops.filter(s => !s.done);
  riderInfo.innerHTML = `${esc(d.rider.vehicle)} · capacity ${d.rider.capacity} parcels · ${upcoming.length ? `<b>${upcoming.length} stops left</b>` : 'No active deliveries – waiting for dispatch'}`;
  stops.innerHTML = d.stops.slice().reverse().slice(0, 30).reverse().map((s, i) => {
    const mins = Math.max(0, Math.round((s.arriveAt - d.now) / d.msPerMin));
    return `<div class="item ${s.done ? '' : (s === upcoming[0] ? 'selected' : '')}" style="${s.done ? 'opacity:.55' : ''}">
      <div class="pin ${s.type === 'pickup' ? 'pharmacy' : 'drop'}" style="width:28px;height:28px">${s.type === 'pickup' ? '✚' : '⌂'}</div>
      <div class="grow"><div class="title">${s.type === 'pickup' ? 'Pick up' : 'Deliver'} ${s.orderId}</div>
        <div class="muted small">${esc(s.label)}${s.order && s.order.coldChain ? ' · <span class="badge cold">❄ keep cold</span>' : ''}${s.order && s.order.priority === 'urgent' ? ' <span class="badge urgent">Urgent</span>' : ''}</div></div>
      <div class="small" style="text-align:right">${s.done ? '✓ done' : `in ${mins} min`}<div class="muted">${s.legKm} km</div></div></div>`;
  }).join('') || '<div class="muted">Nothing assigned yet.</div>';

  const key = d.legs.length + ':' + upcoming.length;
  if (key !== lastKey) {
    pathLayer.clearLayers(); stopLayer.clearLayers();
    d.legs.forEach(p => L.polyline(p, { color, weight: 5, opacity: .85 }).addTo(pathLayer));
    upcoming.forEach((s, i) => L.marker([s.lat, s.lng], { icon: numberIcon(i + 1, color) }).bindTooltip(`${s.type} ${s.orderId}`).addTo(stopLayer));
    lastKey = key;
    if (d.legs.length) { map.fitBounds(L.latLngBounds(d.legs.flat()).pad(0.2)); fitted = true; }
  }
  if (!me) { me = L.marker([d.position.lat, d.position.lng], { icon: riderIcon(color), zIndexOffset: 2000 }).addTo(map); if (!fitted) map.setView([d.position.lat, d.position.lng], 13); }
  else slideMarker(me, d.position, 900);
}
poll();
setInterval(poll, 1000);
