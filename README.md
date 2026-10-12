# ArcGIS Solar Panel Efficiency Analyzer

An interactive campus digital twin that shows **which rooftop solar panels are
losing production to tree shadows, when, and why** — and lets you model the
energy gain from trimming or removing specific trees.

Built for the Esri Redlands campus (Building E) using **real, hosted ArcGIS
Online data**: a drone-captured photorealistic Gaussian Splat, true
orthomosaic, Digital Surface Model, 642 extracted solar panels, and 195
detected trees.

## Why this demo

It directly answers the recurring customer question *"What can I actually do
with a Gaussian Splat?"* — by pairing the photoreal 3D twin with an
operational GIS workflow: quantified shadow impact, a 0–100 Solar Exposure
Score per panel, tree-level impact analysis, and a vegetation-management
what-if scenario.

## Features (MVP functional requirements)

| FR | What it does |
| --- | --- |
| FR-1 | Campus digital twin: Gaussian Splat, true ortho, DSM, footprint, trees, panels, all togglable |
| FR-2 | Time-of-day slider (6 AM–7 PM, July 15) drives the real sun position in the 3D scene |
| FR-3 | Geometric shadow model computes each tree's shadow footprint and panel intersections live |
| FR-4 | Every panel gets a live 0–100 Solar Exposure Score, color-coded on the roof |
| FR-5 | Click a panel for its ID, current/daily sunlight %, shadowed time, and efficiency estimate |
| FR-6 | Click a tree for affected-panel count, average shading hours/day, estimated kWh/day loss |
| FR-7 | Remove a tree (what-if) and compare campus-wide daily production before/after |

## Real data sources (ArcGIS Online, org `ivt.maps.arcgis.com`)

| Layer | Item | Type |
| --- | --- | --- |
| Gaussian Splat | `Spexi Redlands GS` (`7f185e5b93cf42b79345b049e5b7bf45`) | 3D Tiles |
| Integrated Mesh | `Esri_Campus_July1_2018 3D Mesh` (`cb41846e2fa24249ba5b2a99e5033acd`) | Scene Service |
| True Orthomosaic | `Esri_Campus_July1_2018 True Ortho` | Tiled Map Service |
| DSM | `Esri_Campus_July1_2018 Digital Surface Model` | Tiled Map Service |
| Building footprint | `Building_E_Footprint` | Feature Service |
| Trees (195, with height) | `Esri_BuildingE_Trees` | Feature Service |
| Solar panels (642, with WattHours) | `Building_E_Extracted_Solar_Panels` | Feature Service |
| 3D tree models (visual only) | Esri `Open3D_Trees_v1` | Scene Service |

All items are public; the feature/image service URLs and portal item IDs are
in `js/data-sources.js`.

## How the analysis works

* **Sun position** is computed with a standard NOAA solar-position formula
  (`js/solar.js`) from the campus lat/lon and the selected date/time. The same
  `Date` drives `view.environment.lighting`, so the rendered 3D shadows and
  the analytic scores always agree.
* **Shadow model**: each tree casts a simplified wedge-shaped shadow (length =
  `height / tan(sun altitude)`, pointing opposite the sun's azimuth, widened
  by an estimated canopy radius). A panel's obstruction is the strongest
  overlap from any non-removed tree.
* **Solar Exposure Score** = `100 - obstruction * (100 - floor)`, with a
  diffuse-light floor so panels are never scored as literally zero in
  daylight.
* **Daily aggregates** (sunlight %, shadowed hours, tree impact, campus-wide
  comparison) sample the shadow model every 30 minutes across daylight hours.
  This is a transparent, explainable approximation for demo/triage purposes —
  not a substitute for ArcGIS's physically based Solar Radiation tools (see
  Stretch Goals in the original MVP doc).

This is intentionally implemented with `view.environment.lighting.date` +
custom geometry (the documented approach for 3D sun/shadow scenes) rather
than the `arcgis-time-slider` component, which is designed for filtering
time-enabled *data*, not driving solar position.

## Running it

1. Copy `config.example.js` to `config.js` and set your ArcGIS API key
   (never commit `config.js` — it's git-ignored). `config.js` loads after
   `config.production.js` and overrides it locally, so your dev key takes
   precedence without touching the committed deploy key.
2. Serve the folder with any static file server, e.g.:
   ```bash
   python3 -m http.server 8080
   ```
3. Open `http://localhost:8080/`.

No build step, bundler, or framework — plain ESM + the ArcGIS Maps SDK for
JavaScript 5.0 web components, loaded from CDN.

## Project structure

```
index.html            Page shell, ArcGIS web components, UI panels
css/style.css          Styling
js/app.js              App bootstrap, layers, selection, UI wiring
js/solar.js            Sun-position + shadow/exposure math (no dependencies)
js/data-sources.js      Real hosted item IDs / service URLs
config.example.js      Template for your local, git-ignored API key
config.production.js   Committed, referrer-restricted public deploy key (GitHub Pages)
```

## Stretch goals (not in this MVP)

Solar Radiation Tool integration for physically modeled production,
seasonal/historical comparisons, an AI assistant for natural-language
queries, IoT production feeds, and a campus-wide sustainability dashboard —
see the original MVP document for details.
