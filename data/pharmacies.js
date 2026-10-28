// Sample pharmacy dataset for Chennai (fictional names, real neighbourhood coordinates).
// Stock is generated deterministically from medicines.js so every run looks the same.
const medicines = require('./medicines');

const base = [
  { name: 'Adyar Health Pharmacy', area: 'Adyar', lat: 13.0012, lng: 80.2565, open24: true },
  { name: 'T Nagar Medicals', area: 'T Nagar', lat: 13.0418, lng: 80.2341, open24: true },
  { name: 'Anna Nagar Care Chemists', area: 'Anna Nagar', lat: 13.0850, lng: 80.2101, open24: true },
  { name: 'Velachery Wellness Pharmacy', area: 'Velachery', lat: 12.9791, lng: 80.2209, open24: false },
  { name: 'Mylapore Family Medicals', area: 'Mylapore', lat: 13.0339, lng: 80.2690, open24: false },
  { name: 'Tambaram LifeLine Pharmacy', area: 'Tambaram', lat: 12.9249, lng: 80.1270, open24: true },
  { name: 'Porur Plus Pharmacy', area: 'Porur', lat: 13.0382, lng: 80.1565, open24: false },
  { name: 'Guindy Medi Point', area: 'Guindy', lat: 13.0067, lng: 80.2206, open24: false },
  { name: 'Nungambakkam Chemists', area: 'Nungambakkam', lat: 13.0569, lng: 80.2425, open24: true },
  { name: 'Egmore Central Pharmacy', area: 'Egmore', lat: 13.0732, lng: 80.2609, open24: true },
  { name: 'Kodambakkam Medicals', area: 'Kodambakkam', lat: 13.0521, lng: 80.2255, open24: false },
  { name: 'Perambur Health Store', area: 'Perambur', lat: 13.1180, lng: 80.2330, open24: false },
  { name: 'Royapettah Pharma', area: 'Royapettah', lat: 13.0540, lng: 80.2640, open24: false },
  { name: 'Besant Nagar Seaside Pharmacy', area: 'Besant Nagar', lat: 12.9996, lng: 80.2668, open24: false },
  { name: 'Thiruvanmiyur Medicals', area: 'Thiruvanmiyur', lat: 12.9830, lng: 80.2594, open24: false },
  { name: 'Sholinganallur OMR Pharmacy', area: 'Sholinganallur', lat: 12.9010, lng: 80.2279, open24: true },
  { name: 'Chromepet Care Pharmacy', area: 'Chromepet', lat: 12.9516, lng: 80.1462, open24: false },
  { name: 'Ashok Nagar Medicals', area: 'Ashok Nagar', lat: 13.0358, lng: 80.2108, open24: false },
  { name: 'KK Nagar Chemists', area: 'KK Nagar', lat: 13.0410, lng: 80.1990, open24: false },
  { name: 'Vadapalani Health Hub', area: 'Vadapalani', lat: 13.0500, lng: 80.2121, open24: true },
  { name: 'Kilpauk Medicals', area: 'Kilpauk', lat: 13.0826, lng: 80.2420, open24: false },
  { name: 'Ambattur Pharma Point', area: 'Ambattur', lat: 13.1143, lng: 80.1548, open24: false },
  { name: 'Pallavaram Medicals', area: 'Pallavaram', lat: 12.9675, lng: 80.1491, open24: false },
  { name: 'Medavakkam Pharmacy', area: 'Medavakkam', lat: 12.9171, lng: 80.1923, open24: false },
  { name: 'Washermanpet Chemists', area: 'Washermanpet', lat: 13.1140, lng: 80.2870, open24: false },
  { name: 'Saidapet Medicals', area: 'Saidapet', lat: 13.0213, lng: 80.2231, open24: false },
  { name: 'Koyambedu Wholesale Pharma', area: 'Koyambedu', lat: 13.0694, lng: 80.1948, open24: true },
  { name: 'Perungudi Medicals', area: 'Perungudi', lat: 12.9654, lng: 80.2461, open24: false }
];

// Deterministic pseudo-random generator (mulberry32) so stock is reproducible.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = base.map((p, i) => {
  const rand = rng(1000 + i);
  const stock = {};
  medicines.forEach(m => {
    // ~85% availability; cold-chain items only in a subset of stores
    const pAvail = m.coldChain ? 0.55 : 0.85;
    stock[m.id] = rand() < pAvail ? 5 + Math.floor(rand() * 60) : 0;
  });
  return {
    id: 'PH' + String(i + 1).padStart(2, '0'),
    ...p,
    phone: '+91 44 ' + (24000000 + Math.floor(rand() * 999999)),
    rating: (3.8 + rand() * 1.2).toFixed(1),
    stock
  };
});
