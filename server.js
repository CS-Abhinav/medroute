// MedRoute - Web GIS medicine delivery (Chennai demo)
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { store, reset, verifyPassword, hashPassword, publicUser } = require('./lib/store');
const { haversineKm, pointInPolygon, sampleDemandPoint, rng } = require('./lib/geo');
const routing = require('./lib/routing');
const { screen, ALLOWED_MIME, MAX_BYTES } = require('./lib/screening');
const { dispatch, riderPosition, refreshStatuses, startAutoDispatch, setStatus, msPerMin } = require('./lib/dispatch');
const { benchmark } = require('./lib/optimizer');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype))
});

// ---------------- helpers ----------------
const ring = store.serviceArea.geometry.coordinates[0];
const inServiceArea = pt => pointInPolygon(pt, ring);
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function auth(...roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    const userId = store.sessions.get(token);
    const user = store.users.find(u => u.id === userId);
    if (!user) return res.status(401).json({ error: 'Please log in' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    req.user = user;
    next();
  };
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function deliveryFee(km, priority) {
  return Math.round(20 + 6 * km + (priority === 'urgent' ? 40 : 0));
}

// Pharmacies that stock every item, ranked by road distance to the customer.
async function rankPharmacies(drop, items) {
  const candidates = store.pharmacies.filter(p => items.every(it => (p.stock[it.medId] || 0) >= it.qty));
  const top = candidates
    .map(p => ({ p, straightKm: haversineKm(p, drop) }))
    .sort((a, b) => a.straightKm - b.straightKm)
    .slice(0, 6);
  if (!top.length) return [];
  const road = await routing.oneToMany(drop, top.map(t => t.p));
  return top.map((t, i) => ({
    id: t.p.id, name: t.p.name, area: t.p.area, lat: t.p.lat, lng: t.p.lng, open24: t.p.open24,
    straightKm: +t.straightKm.toFixed(2), roadKm: +road[i].km.toFixed(2), etaMin: Math.round(road[i].min + 8)
  })).sort((a, b) => a.roadKm - b.roadKm);
}

function orderView(o, viewer) {
  refreshStatuses();
  const rider = o.riderId && store.riders.find(r => r.id === o.riderId);
  const out = { ...o };
  if (o.prescription) {
    out.prescription = { ...o.prescription, url: `/api/files/${o.prescription.file}` };
    if (viewer.role === 'customer') delete out.prescription.ocrText;
  }
  if (rider) {
    const now = Date.now();
    out.rider = { id: rider.id, name: rider.name, vehicle: rider.vehicle, position: riderPosition(rider, now) };
    // legs relevant to this order: from now until its drop
    out.riderPath = rider.legs.filter(l => l.arriveAt > now && l.departAt <= (o.plan?.dropAt || 0)).map(l => l.path);
    out.etaMin = o.plan?.dropAt ? Math.max(0, Math.round((o.plan.dropAt - now) / msPerMin())) : null;
    out.etaRealSec = o.plan?.dropAt ? Math.max(0, Math.round((o.plan.dropAt - now) / 1000)) : null;
  }
  return out;
}

// ---------------- auth ----------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.users.find(u => u.username === String(username || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  store.sessions.set(token, user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/register', (req, res) => {
  const { name, username, password, phone } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  if (!name || !/^[a-z0-9_]{3,20}$/.test(uname) || String(password || '').length < 6) {
    return res.status(400).json({ error: 'Name, username (3-20 letters/digits) and password (6+ chars) are required' });
  }
  if (store.users.some(u => u.username === uname)) return res.status(409).json({ error: 'Username already taken' });
  const user = { id: 'U' + (store.users.length + 1), username: uname, role: 'customer', name: String(name).trim(), phone, passwordHash: hashPassword(password) };
  store.users.push(user);
  const token = crypto.randomBytes(24).toString('hex');
  store.sessions.set(token, user.id);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/auth/me', auth(), (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/logout', auth(), (req, res) => {
  store.sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});

// ---------------- catalogue & GIS ----------------
app.get('/api/medicines', auth(), (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const list = store.medicines.filter(m => !q || m.name.toLowerCase().includes(q) ||
    m.generic.toLowerCase().includes(q) || m.category.toLowerCase().includes(q));
  res.json(list.map(m => ({ ...m, availableAt: store.pharmacies.filter(p => p.stock[m.id] > 0).length })));
});

app.get('/api/pharmacies', auth(), (req, res) => {
  res.json(store.pharmacies.map(p => ({ ...p, itemsInStock: Object.values(p.stock).filter(q => q > 0).length })));
});

app.get('/api/geo/service-area', (req, res) => res.json(store.serviceArea));
app.get('/api/geo/heatmap', auth('admin', 'pharmacist'), (req, res) => {
  const live = store.orders.map(o => [o.drop.lat, o.drop.lng, 1]);
  res.json([...store.history, ...live]);
});
app.get('/api/geo/check', auth(), (req, res) => {
  const pt = { lat: +req.query.lat, lng: +req.query.lng };
  res.json({ inside: inServiceArea(pt) });
});

// Road route between two points (checkout preview)
app.get('/api/geo/route', auth(), asyncH(async (req, res) => {
  const [a, b] = [req.query.from, req.query.to].map(s => { const [lat, lng] = String(s).split(',').map(Number); return { lat, lng }; });
  const geo = await routing.routeGeometry([a, b]);
  res.json({ path: geo.legs[0], source: geo.source });
}));

// Travel-time grid for isochrones around a pharmacy (contoured on the client with Turf isobands)
app.get('/api/geo/isochrone', auth('admin', 'pharmacist', 'customer'), asyncH(async (req, res) => {
  const ph = store.pharmacies.find(p => p.id === req.query.pharmacyId);
  if (!ph) return res.status(404).json({ error: 'Pharmacy not found' });
  const radiusKm = Math.min(10, +req.query.radiusKm || 7);
  const cellKm = Math.max(0.5, +req.query.cellKm || 0.8);
  const dLat = cellKm / 111, dLng = cellKm / (111 * Math.cos((ph.lat * Math.PI) / 180));
  const steps = Math.ceil(radiusKm / cellKm);
  const grid = [];
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) grid.push({ lat: ph.lat + i * dLat, lng: ph.lng + j * dLng });
  }
  const times = await routing.oneToMany(ph, grid);
  res.json({
    pharmacy: { id: ph.id, name: ph.name, lat: ph.lat, lng: ph.lng },
    cols: 2 * steps + 1, rows: 2 * steps + 1,
    points: grid.map((g, k) => ({ lat: g.lat, lng: g.lng, min: +times[k].min.toFixed(1), inside: inServiceArea(g) })),
    source: routing.status().osrmHealthy ? 'osrm' : 'haversine'
  });
}));

app.post('/api/pharmacies/best', auth(), asyncH(async (req, res) => {
  const { lat, lng, items } = req.body || {};
  const drop = { lat: +lat, lng: +lng };
  if (!inServiceArea(drop)) return res.status(400).json({ error: 'This location is outside our Chennai service area' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });
  const ranked = await rankPharmacies(drop, items);
  if (!ranked.length) return res.status(404).json({ error: 'No single pharmacy has all the items in stock. Try removing an item.' });
  res.json(ranked);
}));

// Uploaded prescriptions are only visible to the owner, pharmacists and admins
app.get('/api/files/:name', auth(), (req, res) => {
  const name = path.basename(req.params.name);
  const order = store.orders.find(o => o.prescription && o.prescription.file === name);
  if (!order) return res.status(404).end();
  if (req.user.role === 'customer' && order.customerId !== req.user.id) return res.status(403).end();
  res.sendFile(path.join(UPLOAD_DIR, name));
});

// ---------------- orders ----------------
function runScreening(order, file, body, user) {
  const hash = fileHash(file.path);
  const dup = store.orders.find(o => o.id !== order.id && o.prescription && o.prescription.hash === hash && o.customerId !== user.id);
  order.prescription = {
    file: file.filename, originalName: file.originalname, mime: file.mimetype, size: file.size, hash,
    ocrText: String(body.ocrText || '').slice(0, 20000), uploadedAt: Date.now()
  };
  setStatus(order, 'screening', 'Prescription uploaded, automated screening started');
  const rxItems = order.items.filter(i => i.rx).map(i => store.medicines.find(m => m.id === i.medId));
  // Short artificial delay so the customer sees the "waiting for approval" stages
  setTimeout(() => {
    const result = screen({
      text: order.prescription.ocrText, file, blurScore: body.blurScore === '' || body.blurScore == null ? null : +body.blurScore,
      user, rxItems, duplicateOf: dup && dup.id
    });
    order.prescription.screening = result;
    if (result.decision === 'approved') {
      order.approvedAt = Date.now();
      order.approvedBy = 'Automated screening';
      setStatus(order, 'approved', `Screening score ${result.score}/100 - auto-approved`);
    } else if (result.decision === 'pending_review') {
      setStatus(order, 'pending_review', `Screening score ${result.score}/100 - waiting for pharmacist`);
    } else {
      order.rejectionReason = result.summary;
      setStatus(order, 'rejected', `Screening score ${result.score}/100 - rejected`);
    }
  }, 4500);
}

app.post('/api/orders', auth('customer'), upload.single('prescription'), asyncH(async (req, res) => {
  let data;
  try { data = JSON.parse(req.body.data || '{}'); } catch { return res.status(400).json({ error: 'Bad order data' }); }
  const drop = { lat: +data.lat, lng: +data.lng, address: String(data.address || '').slice(0, 200) };
  if (!inServiceArea(drop)) return res.status(400).json({ error: 'Delivery location is outside the service area' });
  const items = (data.items || []).map(it => {
    const m = store.medicines.find(x => x.id === it.medId);
    return m && { medId: m.id, name: m.name, qty: Math.max(1, Math.min(10, +it.qty || 1)), price: m.price, rx: m.rx, coldChain: m.coldChain };
  }).filter(Boolean);
  if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
  const rxRequired = items.some(i => i.rx);
  if (rxRequired && !req.file) return res.status(400).json({ error: 'A prescription (PDF/JPG/PNG) is required for the selected medicines' });

  const ranked = await rankPharmacies(drop, items);
  const ph = store.pharmacies.find(p => p.id === (ranked.find(r => r.id === data.pharmacyId) || ranked[0] || {}).id);
  if (!ph) return res.status(404).json({ error: 'No pharmacy can fulfil this order right now' });
  const rank = ranked.find(r => r.id === ph.id);
  items.forEach(i => { ph.stock[i.medId] -= i.qty; });

  const priority = data.priority === 'urgent' ? 'urgent' : 'normal';
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const fee = deliveryFee(rank.roadKm, priority);
  const order = {
    id: 'ORD' + store.nextOrderNo++, customerId: req.user.id, customerName: req.user.name,
    items, rxRequired, coldChain: items.some(i => i.coldChain), priority,
    pharmacyId: ph.id, pickup: { lat: ph.lat, lng: ph.lng, name: ph.name },
    drop, roadKm: rank.roadKm, subtotal, deliveryFee: fee, total: subtotal + fee,
    payment: data.payment === 'upi' ? 'UPI (demo)' : 'Cash on delivery',
    createdAt: Date.now(), status: 'placed', statusHistory: [{ status: 'placed', at: Date.now(), note: `Order placed at ${ph.name}` }]
  };
  store.orders.push(order);
  if (rxRequired) runScreening(order, req.file, req.body, req.user);
  else { order.approvedAt = Date.now(); setStatus(order, 'approved', 'No prescription needed - ready for dispatch'); }
  res.json(orderView(order, req.user));
}));

app.post('/api/orders/:id/prescription', auth('customer'), upload.single('prescription'), (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'rejected') return res.status(400).json({ error: 'Only rejected orders can be re-submitted' });
  if (!req.file) return res.status(400).json({ error: 'Please attach a PDF/JPG/PNG file' });
  order.rejectionReason = null;
  runScreening(order, req.file, req.body, req.user);
  res.json(orderView(order, req.user));
});

app.post('/api/orders/:id/cancel', auth('customer'), (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['placed', 'screening', 'pending_review', 'rejected', 'approved'].includes(order.status)) {
    return res.status(400).json({ error: 'Order is already out for delivery' });
  }
  const ph = store.pharmacies.find(p => p.id === order.pharmacyId);
  order.items.forEach(i => { ph.stock[i.medId] += i.qty; });
  setStatus(order, 'cancelled', 'Cancelled by customer');
  res.json(orderView(order, req.user));
});

app.get('/api/orders/mine', auth('customer'), (req, res) => {
  refreshStatuses();
  res.json(store.orders.filter(o => o.customerId === req.user.id).reverse()
    .map(o => ({ id: o.id, status: o.status, total: o.total, createdAt: o.createdAt, items: o.items.length, pharmacy: o.pickup.name })));
});

app.get('/api/orders/:id', auth(), (req, res) => {
  const o = store.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const u = req.user;
  const allowed = u.role === 'admin' || u.role === 'pharmacist' || o.customerId === u.id || (u.role === 'rider' && o.riderId === u.riderId);
  if (!allowed) return res.status(403).json({ error: 'Not your order' });
  res.json(orderView(o, u));
});

// ---------------- pharmacist ----------------
app.get('/api/pharmacist/queue', auth('pharmacist', 'admin'), (req, res) => {
  const withRx = store.orders.filter(o => o.rxRequired && o.prescription).reverse();
  res.json({
    pending: withRx.filter(o => o.status === 'pending_review').map(o => orderView(o, req.user)),
    recent: withRx.filter(o => o.status !== 'pending_review').slice(0, 25).map(o => orderView(o, req.user))
  });
});

app.post('/api/pharmacist/orders/:id/decision', auth('pharmacist', 'admin'), (req, res) => {
  const o = store.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!['pending_review', 'screening'].includes(o.status) && !(o.status === 'approved' && o.approvedBy === 'Automated screening')) {
    return res.status(400).json({ error: `Order is ${o.status}` });
  }
  const { decision, reason } = req.body || {};
  if (decision === 'approve') {
    o.approvedAt = Date.now(); o.approvedBy = req.user.name;
    setStatus(o, 'approved', `Approved by ${req.user.name}`);
  } else if (decision === 'reject') {
    o.rejectionReason = String(reason || 'Prescription not valid').slice(0, 300);
    setStatus(o, 'rejected', `Rejected by ${req.user.name}: ${o.rejectionReason}`);
  } else return res.status(400).json({ error: 'decision must be approve or reject' });
  res.json(orderView(o, req.user));
});

// ---------------- rider ----------------
app.get('/api/rider/me', auth('rider'), (req, res) => {
  refreshStatuses();
  const r = store.riders.find(x => x.id === req.user.riderId);
  const now = Date.now();
  res.json({
    rider: { id: r.id, name: r.name, vehicle: r.vehicle, capacity: r.capacity, home: r.home },
    position: riderPosition(r, now), now,
    stops: r.stops.map(s => ({ ...s, done: s.arriveAt <= now, order: store.orders.find(o => o.id === s.orderId) })),
    legs: r.legs.filter(l => l.arriveAt > now).map(l => l.path),
    msPerMin: msPerMin()
  });
});

// ---------------- admin ----------------
app.get('/api/admin/state', auth('admin'), (req, res) => {
  refreshStatuses();
  const now = Date.now();
  const counts = {};
  store.orders.forEach(o => { counts[o.status] = (counts[o.status] || 0) + 1; });
  res.json({
    now, settings: store.settings, counts, routing: routing.status(),
    riders: store.riders.map(r => ({
      id: r.id, name: r.name, vehicle: r.vehicle, capacity: r.capacity,
      position: riderPosition(r, now),
      upcoming: r.stops.filter(s => s.arriveAt > now).length,
      remainingPath: r.legs.filter(l => l.arriveAt > now).map(l => l.path)
    })),
    orders: store.orders.slice().reverse().slice(0, 80).map(o => ({
      id: o.id, status: o.status, priority: o.priority, coldChain: o.coldChain, customerName: o.customerName,
      pickup: o.pickup, drop: o.drop, riderId: o.riderId, createdAt: o.createdAt, total: o.total,
      etaMin: o.plan?.dropAt ? Math.max(0, Math.round((o.plan.dropAt - now) / msPerMin())) : null
    })),
    lastDispatch: store.lastDispatch
  });
});

app.post('/api/admin/dispatch', auth('admin'), asyncH(async (req, res) => {
  const result = await dispatch({ reason: 'manual' });
  if (result.error) return res.status(400).json(result);
  res.json(result);
}));

app.post('/api/admin/settings', auth('admin'), (req, res) => {
  const { autoDispatch, simSpeed, batchWindowSec } = req.body || {};
  if (typeof autoDispatch === 'boolean') store.settings.autoDispatch = autoDispatch;
  if (simSpeed && !store.riders.some(r => r.stops.some(s => s.arriveAt > Date.now()))) {
    store.settings.simSpeed = Math.max(5, Math.min(120, +simSpeed));
  }
  if (batchWindowSec != null) store.settings.batchWindowSec = Math.max(0, Math.min(120, +batchWindowSec));
  res.json(store.settings);
});

app.post('/api/admin/demo-orders', auth('admin'), (req, res) => {
  const count = Math.max(1, Math.min(25, +(req.body || {}).count || 8));
  const rand = rng(Date.now() & 0xffff);
  const otc = store.medicines.filter(m => !m.rx);
  const created = [];
  for (let i = 0; i < count; i++) {
    const drop = sampleDemandPoint(rand, store.demandCentres, ring, 1.2);
    const items = [otc[Math.floor(rand() * otc.length)]];
    if (rand() < 0.15) items.push(store.medicines.find(m => m.id === 'M20')); // insulin = cold chain
    const ph = store.pharmacies
      .filter(p => items.every(m => p.stock[m.id] > 0))
      .sort((a, b) => haversineKm(a, drop) - haversineKm(b, drop))[0];
    if (!ph) continue;
    const priority = rand() < 0.2 ? 'urgent' : 'normal';
    const km = haversineKm(ph, drop) * routing.DETOUR_FACTOR;
    const subtotal = items.reduce((s, m) => s + m.price, 0);
    const order = {
      id: 'ORD' + store.nextOrderNo++, customerId: 'demo', customerName: `Demo customer (${drop.area})`,
      items: items.map(m => ({ medId: m.id, name: m.name, qty: 1, price: m.price, rx: m.rx, coldChain: m.coldChain })),
      rxRequired: false, coldChain: items.some(m => m.coldChain), priority,
      pharmacyId: ph.id, pickup: { lat: ph.lat, lng: ph.lng, name: ph.name },
      drop: { lat: drop.lat, lng: drop.lng, address: drop.area + ', Chennai' }, roadKm: +km.toFixed(2),
      subtotal, deliveryFee: deliveryFee(km, priority), total: subtotal + deliveryFee(km, priority), payment: 'Demo',
      createdAt: Date.now() + i, approvedAt: Date.now(), status: 'approved',
      statusHistory: [{ status: 'approved', at: Date.now(), note: 'Demo order generated by admin' }]
    };
    store.orders.push(order);
    created.push(order.id);
  }
  res.json({ created });
});

app.post('/api/admin/benchmark', auth('admin'), asyncH(async (req, res) => {
  const n = Math.max(2, Math.min(7, +(req.body || {}).n || 6));
  const rand = rng(Date.now() & 0xffff);
  const rider = { id: 'BENCH', capacity: 3, ...sampleDemandPoint(rand, store.demandCentres, ring, 1.5) };
  const orders = Array.from({ length: n }, (_, k) => {
    const drop = sampleDemandPoint(rand, store.demandCentres, ring, 1.2);
    const ph = store.pharmacies.slice().sort((a, b) => haversineKm(a, drop) - haversineKm(b, drop))[Math.floor(rand() * 3)];
    return { id: 'B' + k, pickup: { lat: ph.lat, lng: ph.lng, name: ph.name }, drop, priority: 'normal', coldChain: false, createdAt: k };
  });
  const matrix = await routing.distanceMatrix([rider, ...orders.flatMap(o => [o.pickup, o.drop])]);
  const result = benchmark({ rider, orders, matrix });
  res.json({ ...result, matrixSource: matrix.source, rider, orders });
}));

app.post('/api/admin/reset', auth('admin'), (req, res) => { reset(); res.json({ ok: true }); });

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

startAutoDispatch();
app.listen(PORT, () => console.log(`MedRoute running at http://localhost:${PORT}`));
