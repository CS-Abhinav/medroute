// In-memory "database". Everything resets when the server restarts,
// which is what we want for a classroom demo.
const crypto = require('crypto');
const medicines = require('../data/medicines');
const pharmacySeed = require('../data/pharmacies');
const { serviceArea, riderHubs, demandCentres } = require('../data/geo');
const { sampleDemandPoint, rng } = require('./geo');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

// Demo accounts (also listed on the login page)
const seedUsers = [
  { username: 'customer', password: 'customer123', role: 'customer', name: 'Priya Raman', phone: '98400 11111' },
  { username: 'arjun', password: 'arjun123', role: 'customer', name: 'Arjun Kumar', phone: '98400 22222' },
  { username: 'pharmacist', password: 'pharma123', role: 'pharmacist', name: 'Dr. S. Anand (Pharmacist)' },
  { username: 'admin', password: 'admin123', role: 'admin', name: 'Dispatch Admin' },
  ...riderHubs.map((r, i) => ({ username: 'rider' + (i + 1), password: 'rider123', role: 'rider', name: r.name, riderId: r.id }))
];

const store = {
  users: [],
  sessions: new Map(),        // token -> userId
  medicines,
  pharmacies: [],
  riders: [],
  orders: [],
  history: [],                // historical demand points for the heatmap
  lastDispatch: null,
  settings: { autoDispatch: true, simSpeed: 30, batchWindowSec: 10 },
  nextOrderNo: 1001,
  serviceArea,
  demandCentres
};

function freshRiders() {
  return riderHubs.map(r => ({ ...r, home: { lat: r.lat, lng: r.lng }, stops: [], legs: [] }));
}

function generateHistory(n = 700) {
  const rand = rng(2024);
  const ring = serviceArea.geometry.coordinates[0];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = sampleDemandPoint(rand, demandCentres, ring, 1.6);
    pts.push([+p.lat.toFixed(5), +p.lng.toFixed(5), 0.4 + rand() * 0.6]);
  }
  return pts;
}

function reset({ keepUsers = true } = {}) {
  if (!keepUsers || !store.users.length) {
    store.users = seedUsers.map((u, i) => {
      const { password, ...rest } = u;
      return { id: 'U' + (i + 1), ...rest, passwordHash: hashPassword(password) };
    });
  }
  store.pharmacies = JSON.parse(JSON.stringify(pharmacySeed));
  store.riders = freshRiders();
  store.orders = [];
  store.history = generateHistory();
  store.lastDispatch = null;
  store.nextOrderNo = 1001;
}

reset({ keepUsers: false });

const publicUser = u => u && ({ id: u.id, username: u.username, role: u.role, name: u.name, phone: u.phone, riderId: u.riderId });

module.exports = { store, reset, hashPassword, verifyPassword, publicUser };
