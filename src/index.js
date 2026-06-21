const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Radius Explorer API running" });
});

// ── SEARCH (address → coordinates via Nominatim) ──────────
app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`;
    const response = await fetch(url, {
      headers: { "User-Agent": "RadiusExplorer/1.0 contact@radiusexplorer.com" },
    });
    const data = await response.json();
    if (!data.length) return res.status(404).json({ error: "Location not found" });

    const results = data.map((item) => ({
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      display_name: item.display_name,
      type: item.type,
    }));

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

// ── PLACES (find places in radius via Overpass API) ───────
app.get("/api/places", async (req, res) => {
  const { lat, lon, radius = 1000 } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const r = Math.min(parseInt(radius), 50000); // cap at 50km

  const query = `
    [out:json][timeout:30];
    (
      node["amenity"](around:${r},${lat},${lon});
      node["shop"](around:${r},${lat},${lon});
      node["tourism"](around:${r},${lat},${lon});
      node["healthcare"](around:${r},${lat},${lon});
      node["leisure"](around:${r},${lat},${lon});
    );
    out body;
  `;

  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
      headers: { "Content-Type": "text/plain" },
    });
    const data = await response.json();

    const places = data.elements.map((el) => ({
      id: el.id,
      lat: el.lat,
      lon: el.lon,
      name: el.tags?.name || "Unnamed",
      type:
        el.tags?.amenity ||
        el.tags?.shop ||
        el.tags?.tourism ||
        el.tags?.healthcare ||
        el.tags?.leisure ||
        "place",
      phone: el.tags?.phone || null,
      website: el.tags?.website || null,
      opening_hours: el.tags?.opening_hours || null,
    }));

    // Group by type for stats
    const stats = places.reduce((acc, p) => {
      acc[p.type] = (acc[p.type] || 0) + 1;
      return acc;
    }, {});

    res.json({ places, total: places.length, stats });
  } catch (err) {
    res.status(500).json({ error: "Places search failed", detail: err.message });
  }
});

// ── DISTANCE (via OSRM public API) ────────────────────────
app.get("/api/distance", async (req, res) => {
  const { lat1, lon1, lat2, lon2, mode = "driving" } = req.query;
  if (!lat1 || !lon1 || !lat2 || !lon2)
    return res.status(400).json({ error: "lat1, lon1, lat2, lon2 required" });

  const profile = mode === "walking" ? "foot" : mode === "cycling" ? "bike" : "car";

  try {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson&steps=true`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.code !== "Ok") return res.status(404).json({ error: "Route not found" });

    const route = data.routes[0];
    res.json({
      distance_m: route.distance,
      distance_km: (route.distance / 1000).toFixed(2),
      duration_s: route.duration,
      duration_min: Math.ceil(route.duration / 60),
      geometry: route.geometry,
      steps: route.legs[0].steps.map((s) => s.maneuver?.instruction || s.name).filter(Boolean),
    });
  } catch (err) {
    res.status(500).json({ error: "Distance calculation failed", detail: err.message });
  }
});

// ── STATS (area summary) ──────────────────────────────────
app.get("/api/stats", async (req, res) => {
  const { lat, lon, radius = 2000 } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const r = Math.min(parseInt(radius), 50000);

  const query = `
    [out:json][timeout:30];
    (
      node["amenity"](around:${r},${lat},${lon});
      node["shop"](around:${r},${lat},${lon});
    );
    out body;
  `;

  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
    });
    const data = await response.json();

    const counts = {
      total: data.elements.length,
      restaurants: 0, cafes: 0, hospitals: 0, pharmacies: 0,
      schools: 0, banks: 0, shops: 0, hotels: 0, others: 0,
    };

    data.elements.forEach((el) => {
      const a = el.tags?.amenity;
      const s = el.tags?.shop;
      if (a === "restaurant" || a === "fast_food") counts.restaurants++;
      else if (a === "cafe") counts.cafes++;
      else if (a === "hospital" || a === "clinic") counts.hospitals++;
      else if (a === "pharmacy") counts.pharmacies++;
      else if (a === "school" || a === "college" || a === "university") counts.schools++;
      else if (a === "bank" || a === "atm") counts.banks++;
      else if (a === "hotel" || a === "hostel") counts.hotels++;
      else if (s) counts.shops++;
      else counts.others++;
    });

    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: "Stats failed", detail: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Radius Explorer API running on port ${PORT}`));
