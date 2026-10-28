# MedRoute: Web GIS medicine delivery with route optimisation (Chennai)

A college GIS course project. It works like Swiggy or Zomato, but for medicines. Customers order from partner pharmacies on a Leaflet map. Prescriptions for Rx drugs go through automated screening, and a pharmacist reviews them when needed. Riders' routes are optimised across several riders at once.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000. The app needs internet access for the map tiles, the OSRM road routing, Nominatim geocoding and the CDN libraries. If OSRM can't be reached, it falls back to straight-line distance × 1.35.

### Demo accounts

| Role | Username | Password | Page |
|---|---|---|---|
| Customer | `customer` | `customer123` | Shop, cart, prescription upload, live tracking |
| Customer 2 | `arjun` | `arjun123` | |
| Pharmacist | `pharmacist` | `pharma123` | Prescription review queue |
| Admin / dispatch | `admin` | `admin123` | Dispatch console, GIS analysis, algorithm benchmark |
| Rider | `rider1` … `rider6` | `rider123` | Rider's optimised stop list |

New customers can also register. All data is held in memory and resets when the server restarts. The admin page also has a **Reset** button.

## Demo script (about 5 minutes)

1. **Admin**: click **+ Demo orders** (10), then **⚡ Optimise & dispatch**. The naive vs optimised table appears, along with colour-coded rider routes on real roads, stop numbers, and riders moving live. Tick *Show naive plan* to compare the two plans.
2. **Admin → GIS analysis**: open the demand heatmap, the Voronoi pharmacy territories shaded by demand, the 24×7 coverage gaps, isochrones and the nearest-pharmacy tool.
3. **Admin → Algorithm**: run the benchmark against the exact Held-Karp optimum.
4. **Customer**:
   - Add *Amoxicillin* (Rx) and *Paracetamol*, then open **Cart**.
   - Pharmacies are ranked by road distance, with a route preview.
   - Click **Use sample (valid)**: OCR runs in the browser.
   - Click **Place order**: the waiting screen appears, the order is auto-approved (score 100) and auto-dispatched, then tracked live.
5. **Customer**: repeat with **Use sample (poor)**. The order scores about 50 and goes to pharmacist review.
6. **Pharmacist**: open the queue and review the screening report and the image. Approve or reject; the customer's page updates automatically.

## Project structure

```
server.js            Express API (auth, catalogue, orders, pharmacist, admin, GIS endpoints)
lib/optimizer.js     Route optimisation (PDP): regret insertion, simulated annealing, local search, exact DP
lib/optimizer.test.js  Offline correctness + optimality-gap checks  (npm run test:optimizer)
lib/dispatch.js      Batch dispatch, rider timelines, live position simulation
lib/routing.js       OSRM distance matrix / route geometry with haversine fallback
lib/screening.js     Prescription screening rules + scoring
lib/store.js         In-memory database + seeded demo users
data/                Chennai datasets: 28 pharmacies, 30 medicines, rider hubs, service-area polygon
public/              Frontend (vanilla HTML/CSS/JS + Leaflet)
  index.html         Login / register
  customer.html      Shop + map + checkout + prescription upload
  order.html         Waiting-for-approval screen → live tracking
  pharmacist.html    Review queue
  admin.html         Dispatch + GIS analysis + benchmark
  rider.html         Rider route view
```

## Route optimisation

This is a **multi-vehicle Pickup-and-Delivery Problem**, an NP-hard variant of the vehicle routing problem.

**Constraints**
- The pharmacy (pickup) must come before the customer (drop), and both must be on the same rider's route.
- Rider capacity: at most 4 or 5 parcels on board at once.
- Cold-chain items (insulin, vaccines) must be delivered within 40 minutes of pickup.
- Busy riders continue from their last planned stop, so new batches are added to the end of their routes.

**Objective**

`rider travel + service time + 0.5 × Σ(priority weight × delivery time) + penalties`

Urgent orders have weight 3 and normal orders weight 1.

**Pipeline**
1. **Distance matrix.** OSRM Table API over real Chennai roads, at a rider speed of 22 km/h.
2. **Regret-2 insertion.** This builds the starting solution. Orders whose best and second-best insertion costs differ the most are placed first.
3. **Simulated annealing.** Four chains of relocate, exchange, 2-opt and or-opt moves, with geometric cooling.
4. **Polish.** Order reinsertion, or-opt and 2-opt, repeated until nothing improves.
5. **Baseline.** Naive first-come-first-served dispatch, one order per trip by the nearest rider, used for comparison.
6. **Exact check.** Held-Karp dynamic programming with precedence for up to 7 orders, used to measure the optimality gap.

**Typical results**
- About 30–55% less distance and 20–35% faster average delivery than naive dispatch.
- 25 orders solve in under 0.5 s.
- Average gap to the exact optimum is about 0.5% on 7-order instances.

## Prescription screening

The browser extracts text with **Tesseract.js** for images and **pdf.js** for PDFs, and measures sharpness with the variance of the Laplacian. The server then scores the result with weighted checks:

| Check | Weight |
|---|---|
| File type and size | 10 |
| Duplicate file (SHA-256 used by another account) | 10 |
| Legibility | 15 |
| Doctor / clinic markers | 15 |
| Registration number (e.g. TNMC) | 10 |
| Date within 180 days | 15 |
| Patient name matches the account | 10 |
| Each Rx medicine fuzzy-matched (Levenshtein) | 15 |

**Decisions**
- **Auto-approved:** score of 80 or more, all medicines found and a valid date.
- **Pharmacist review:** score of 45 or more.
- **Rejected:** below 45. The customer can upload again.

This is primary screening only. Under Indian rules a registered pharmacist remains responsible for dispensing Schedule H/H1 drugs. In production, OCR should also run on the server, because text extracted in the browser can't be trusted.

## GIS features

- **Base maps:** OSM, Esri grey and satellite, OpenTopoMap, with a layer switcher and scale bar.
- **Service-area polygon:** point-in-polygon validation on both the client and the server.
- **Pharmacy markers:** clustered, with a 24×7 filter.
- **Geocoding:** Nominatim address search, reverse geocoding and browser geolocation.
- **3 km buffer:** spatial query for pharmacies within 3 km (`turf.pointsWithinPolygon`).
- **Pharmacy ranking:** by network (road) distance, not straight-line distance.
- **Isochrones:** an OSRM travel-time grid contoured with `turf.isobands` and clipped to the service area.
- **Voronoi territories:** clipped Thiessen polygons, shaded as a choropleth of demand per territory, with area and density statistics.
- **Coverage-gap analysis:** union of 2.5 km buffers around 24×7 pharmacies, subtracted from the service area.
- **Demand heatmap:** Leaflet.heat.
- **Live tracking:** riders are interpolated along OSRM road geometry.

## Data note

The pharmacy names are fictional. The coordinates are real Chennai neighbourhoods. Stock, demand and orders are generated synthetically.
