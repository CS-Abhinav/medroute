// Shared helpers: auth, API calls, map setup, formatting.
const CHENNAI = [13.0500, 80.2300];

const Auth = {
  get token() { return localStorage.getItem('mr_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('mr_user')); } catch { return null; } },
  save(token, user) { localStorage.setItem('mr_token', token); localStorage.setItem('mr_user', JSON.stringify(user)); },
  clear() { localStorage.removeItem('mr_token'); localStorage.removeItem('mr_user'); },
  home(role) {
    return { customer: '/customer.html', pharmacist: '/pharmacist.html', admin: '/admin.html', rider: '/rider.html' }[role] || '/';
  },
  // Redirect to login unless the user has one of the given roles
  require(...roles) {
    const u = this.user;
    if (!this.token || !u) { location.href = '/'; return null; }
    if (roles.length && !roles.includes(u.role)) { location.href = this.home(u.role); return null; }
    return u;
  },
  async logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    this.clear();
    location.href = '/';
  }
};

async function api(url, opts = {}) {
  const headers = opts.headers || {};
  if (Auth.token) headers.Authorization = 'Bearer ' + Auth.token;
  let body = opts.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(url, { ...opts, headers, body });
  if (res.status === 401 && !url.startsWith('/api/auth/')) { Auth.clear(); location.href = '/'; throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

function toast(msg, ms = 2800) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupee = n => '₹' + Math.round(n).toLocaleString('en-IN');
const timeStr = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const STATUS_LABEL = {
  placed: 'Placed', screening: 'Screening', pending_review: 'Pharmacist review', approved: 'Approved',
  assigned: 'Rider assigned', picked_up: 'Out for delivery', delivered: 'Delivered', rejected: 'Rejected', cancelled: 'Cancelled'
};
const statusBadge = s => `<span class="status ${s}">${STATUS_LABEL[s] || s}</span>`;
const RIDER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#f032e6'];
const riderColor = id => RIDER_COLORS[(parseInt(String(id).replace(/\D/g, ''), 10) - 1) % RIDER_COLORS.length] || '#1d4ed8';

function renderTopbar(user, extra = '') {
  const bar = document.getElementById('topbar');
  bar.className = 'topbar';
  bar.innerHTML = `
    <a class="logo" href="${Auth.home(user.role)}"><span class="mark">✚</span> MedRoute</a>
    <span class="role-chip">${esc(user.role)}</span>
    <div class="spacer"></div>
    ${extra}
    <span class="who">${esc(user.name)}</span>
    <button class="btn sm" id="logoutBtn">Log out</button>`;
  document.getElementById('logoutBtn').onclick = () => Auth.logout();
}

// ---------- Leaflet map factory ----------
function createMap(id, opts = {}) {
  const map = L.map(id, { zoomControl: true, preferCanvas: false, ...opts }).setView(opts.center || CHENNAI, opts.zoom || 12);
  const base = {
    'Streets': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
    'Light grey (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16, attribution: 'Tiles &copy; Esri' }),
    'Dark grey (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16, attribution: 'Tiles &copy; Esri' }),
    'Topographic (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap' }),
    'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Tiles &copy; Esri' })
  };
  base[opts.base || 'Streets'].addTo(map);
  const layerControl = L.control.layers(base, {}, { collapsed: true, position: 'topright' }).addTo(map);
  L.control.scale({ metric: true, imperial: false }).addTo(map);
  return { map, layerControl };
}

function pinIcon(kind, symbol, size = 28, extraClass = '') {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${kind} ${extraClass}" style="width:${size}px;height:${size}px">${symbol}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2]
  });
}
const riderIcon = (color, label = '🛵') => L.divIcon({
  className: '',
  html: `<div class="pin rider" style="width:34px;height:34px;background:${color};font-size:17px">${label}</div>`,
  iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -17]
});
const numberIcon = (n, color) => L.divIcon({
  className: '', html: `<div class="stop-num" style="color:${color}">${n}</div>`, iconSize: [22, 22], iconAnchor: [11, 11]
});

async function addServiceArea(map, layerControl, show = true) {
  const geo = await fetch('/api/geo/service-area').then(r => r.json());
  const layer = L.geoJSON(geo, {
    style: { color: '#0f9d8a', weight: 2, dashArray: '6 6', fillColor: '#0f9d8a', fillOpacity: 0.04 },
    interactive: false
  });
  if (show) layer.addTo(map);
  layerControl.addOverlay(layer, 'Service area');
  return { layer, geo };
}

function pharmacyPopup(p) {
  return `<h4>${esc(p.name)}</h4><div class="muted">${esc(p.area)} · ★ ${p.rating}</div>
    <div>${p.open24 ? '<span class="badge cold">Open 24×7</span>' : '<span class="badge grey">8 AM – 11 PM</span>'}
    ${p.itemsInStock != null ? `<span class="badge ok">${p.itemsInStock} items in stock</span>` : ''}</div>
    <div class="small muted" style="margin-top:4px">${esc(p.phone)}</div>`;
}

// Animate a marker smoothly between polled positions
function slideMarker(marker, to, ms = 1000) {
  const from = marker.getLatLng();
  const start = performance.now();
  function step(now) {
    const f = Math.min(1, (now - start) / ms);
    marker.setLatLng([from.lat + (to.lat - from.lat) * f, from.lng + (to.lng - from.lng) * f]);
    if (f < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
