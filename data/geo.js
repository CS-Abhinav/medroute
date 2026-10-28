// GIS reference data for Chennai.

// Approximate service-area polygon (Greater Chennai). GeoJSON order: [lng, lat].
// The east edge follows the coastline so points in the sea are rejected.
const serviceArea = {
  type: 'Feature',
  properties: { name: 'MedRoute Chennai service area' },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [80.300, 13.200], [80.230, 13.215], [80.170, 13.190], [80.120, 13.150],
      [80.090, 13.100], [80.085, 13.040], [80.090, 12.980], [80.095, 12.920],
      [80.130, 12.880], [80.170, 12.850], [80.215, 12.835], [80.245, 12.850],
      [80.252, 12.900], [80.258, 12.950], [80.268, 12.990], [80.276, 13.030],
      [80.284, 13.070], [80.292, 13.110], [80.305, 13.150], [80.300, 13.200]
    ]]
  }
};

// Rider hubs (where riders start the day)
const riderHubs = [
  { id: 'R1', name: 'Karthik', lat: 13.0600, lng: 80.2500, capacity: 5, vehicle: 'Bike' },
  { id: 'R2', name: 'Divya', lat: 13.0050, lng: 80.2450, capacity: 5, vehicle: 'Scooter' },
  { id: 'R3', name: 'Suresh', lat: 13.0850, lng: 80.2000, capacity: 5, vehicle: 'Bike' },
  { id: 'R4', name: 'Meena', lat: 12.9500, lng: 80.1450, capacity: 4, vehicle: 'Scooter' },
  { id: 'R5', name: 'Rahul', lat: 12.9200, lng: 80.2250, capacity: 5, vehicle: 'Bike' },
  { id: 'R6', name: 'Lakshmi', lat: 13.1150, lng: 80.2500, capacity: 4, vehicle: 'E-Bike' }
];

// Neighbourhood centroids with relative demand weights, used to generate
// realistic-looking demand points (historical orders and demo orders).
const demandCentres = [
  { area: 'T Nagar', lat: 13.0418, lng: 80.2341, w: 10 },
  { area: 'Anna Nagar', lat: 13.0850, lng: 80.2101, w: 9 },
  { area: 'Adyar', lat: 13.0012, lng: 80.2565, w: 8 },
  { area: 'Velachery', lat: 12.9791, lng: 80.2209, w: 9 },
  { area: 'Mylapore', lat: 13.0339, lng: 80.2690, w: 6 },
  { area: 'Tambaram', lat: 12.9249, lng: 80.1270, w: 6 },
  { area: 'Porur', lat: 13.0382, lng: 80.1565, w: 5 },
  { area: 'Perambur', lat: 13.1180, lng: 80.2330, w: 4 },
  { area: 'Sholinganallur', lat: 12.9010, lng: 80.2279, w: 7 },
  { area: 'Chromepet', lat: 12.9516, lng: 80.1462, w: 4 },
  { area: 'Ambattur', lat: 13.1143, lng: 80.1548, w: 4 },
  { area: 'Egmore', lat: 13.0732, lng: 80.2609, w: 5 },
  { area: 'Vadapalani', lat: 13.0500, lng: 80.2121, w: 6 },
  { area: 'Medavakkam', lat: 12.9171, lng: 80.1923, w: 4 },
  { area: 'Washermanpet', lat: 13.1140, lng: 80.2870, w: 3 }
];

module.exports = { serviceArea, riderHubs, demandCentres };
