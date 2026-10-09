import { CAMPUS, PORTAL_ITEMS, IMAGE_SERVICES, MONTHLY_PEAK_SUN_HOURS, DAYS_IN_MONTH_2026 } from "./data-sources.js";
import { ringCentroid, triangleAreaM2 } from "./geo-utils.js";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  panels: [], // {objectId, areaM2, annualScore, monthlySunlitFraction}
  panelsById: new Map(),
  view: null,
  panelsLayer: null,
  layerView: null,
  selectedIds: null, // null = no selection (campus-wide totals shown instead)
  selectMode: false, // when true, drag draws a rectangle-select instead of panning
};

async function main() {
  const [Graphic, FeatureLayer, TileLayer] = await $arcgis.import([
    "@arcgis/core/Graphic.js",
    "@arcgis/core/layers/FeatureLayer.js",
    "@arcgis/core/layers/TileLayer.js",
  ]);

  const mapEl = document.getElementById("map");
  await customElements.whenDefined("arcgis-map");
  await mapEl.viewOnReady();
  const view = mapEl.view;
  state.view = view;

  // True orthomosaic as base imagery, underneath the panel heatmap layer.
  const trueOrtho = new TileLayer({
    url: IMAGE_SERVICES.trueOrtho,
    title: "True Orthomosaic",
    opacity: 1,
    // Dim + desaturate the base imagery so the solar exposure score overlay (the app's
    // actual data) reads as the visually dominant layer instead of competing with it.
    effect: "brightness(45%) saturate(65%)",
  });
  view.map.add(trueOrtho);

  // ---- Load the same tessellation + annual shadow data the 3D viewer uses ----
  const [tessellationFeatures, shadowBuffer, shadowMeta] = await Promise.all([
    fetch("./data/solar_tessellation_3d.geojson").then((r) => r.json()),
    fetch("./data/shadow_obstruction_annual.bin").then((r) => r.arrayBuffer()),
    fetch("./data/shadow_sun_positions_annual.json").then((r) => r.json()),
  ]);

  const shadow = {
    months: shadowMeta.months,
    hours: shadowMeta.hours,
    altitude: shadowMeta.altitude, // [month][hour]
    panelCount: shadowMeta.panelCount,
    obstruction: new Uint8Array(shadowBuffer),
  };

  const graphics = computeAnnualPanelGraphics(tessellationFeatures.features, shadow, Graphic);
  state.panelsLayer = new FeatureLayer({
    title: "Solar Panels (annual exposure)",
    source: graphics,
    objectIdField: "OBJECTID",
    geometryType: "polygon",
    spatialReference: { wkid: 4326 },
    fields: [
      { name: "OBJECTID", type: "oid" },
      { name: "GRID_ID", type: "string" },
      { name: "annualScore", type: "integer" },
    ],
    renderer: heatmapRenderer(),
    popupEnabled: false,
  });
  view.map.add(state.panelsLayer);

  const panelsLayerView = await view.whenLayerView(state.panelsLayer);
  state.layerView = panelsLayerView;

  if (graphics.length) {
    await view.goTo(graphics, { animate: false });
  }

  renderCampusMetrics();
  drawMonthChart(campusMonthlyAverages());
  setupSelection(view);

  document.getElementById("clear-selection-btn").addEventListener("click", clearSelection);

  document.getElementById("loading-overlay").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Annual scoring -- same DSM ray-cast obstruction data as the 3D viewer
// (elevation/raycast_shadows_annual.py), aggregated across all 12 representative days.
// ---------------------------------------------------------------------------
function lookupObstruction(shadow, objectId, month, hourIndex) {
  const { hours, panelCount, obstruction } = shadow;
  const monthOffset = month * hours.length * panelCount;
  return obstruction[monthOffset + hourIndex * panelCount + (objectId - 1)] / 255;
}

/**
 * For one panel, computes per-month daylight-weighted sunlit fraction (0-1) using the same
 * ray-cast obstruction table and altitude data the 3D viewer reads, then rolls the 12
 * representative days up into a single annual score weighted by MONTHLY_PEAK_SUN_HOURS (a
 * rough seasonal insolation *shape*, NOT measured data -- see data-sources.js) and
 * DAYS_IN_MONTH_2026. This is purely a fraction (0-100), with no area or wattage assumption
 * anywhere in the math -- area is applied afterward, by the caller, to turn the fraction
 * into a measured-m² "sunlit area" figure.
 */
function annualSummaryForPanel(objectId, shadow) {
  const { hours } = shadow;
  const monthlySunlitFraction = new Array(12).fill(0);
  let weightedFractionSum = 0;
  let weightSum = 0;

  for (let m = 0; m < 12; m++) {
    const altitudes = shadow.altitude[m];
    let litSum = 0;
    let litCount = 0;
    for (let hi = 0; hi < hours.length; hi++) {
      if (altitudes[hi] <= 0.5) continue; // sun below horizon
      const obstruction = lookupObstruction(shadow, objectId, m, hi);
      litSum += 1 - obstruction;
      litCount++;
    }
    const sunlitFraction = litCount ? litSum / litCount : 0;
    monthlySunlitFraction[m] = sunlitFraction;

    const weight = MONTHLY_PEAK_SUN_HOURS[m] * DAYS_IN_MONTH_2026[m];
    weightedFractionSum += sunlitFraction * weight;
    weightSum += weight;
  }

  const annualScore = weightSum ? Math.round(100 * (weightedFractionSum / weightSum)) : 0;

  return { monthlySunlitFraction, annualScore };
}

function computeAnnualPanelGraphics(features, shadow, Graphic) {
  const graphics = [];
  for (const f of features) {
    const ring = f.geometry?.coordinates?.[0];
    if (!ring || ring.length < 4) continue;
    const objectId = f.properties.OBJECTID;
    const areaM2 = triangleAreaM2(ring);
    const summary = annualSummaryForPanel(objectId, shadow);

    // Flat 2D ring (drop Z) -- this is the map/heatmap page, so no elevation draping needed.
    const flatRing = ring.map(([x, y]) => [x, y]);
    const centroid = ringCentroid(flatRing);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of flatRing) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const panel = {
      objectId,
      gridId: f.properties.GRID_ID,
      areaM2,
      ring: flatRing,
      centroid,
      bbox: { minX, maxX, minY, maxY },
      ...summary,
    };
    state.panels.push(panel);
    state.panelsById.set(objectId, panel);
    graphics.push(
      new Graphic({
        geometry: { type: "polygon", rings: [flatRing], spatialReference: { wkid: 4326 } },
        attributes: { OBJECTID: objectId, GRID_ID: f.properties.GRID_ID, annualScore: summary.annualScore },
      })
    );
  }
  return graphics;
}

// Continuous red -> amber -> green color ramp driven by each panel's "annualScore"
// attribute (0-100), for a true heatmap look rather than 3 discrete buckets.
function heatmapRenderer() {
  return {
    type: "simple",
    symbol: {
      type: "simple-fill",
      outline: { width: 0 },
    },
    visualVariables: [
      {
        type: "color",
        field: "annualScore",
        stops: [
          { value: 0, color: "#d9534f" },
          { value: 50, color: "#e0a800" },
          { value: 100, color: "#2aa876" },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Campus-wide + selection metrics
// ---------------------------------------------------------------------------
function summarizePanels(panels) {
  const count = panels.length;
  let totalAreaM2 = 0;
  let sunlitAreaM2 = 0;
  let scoreSum = 0;
  const buckets = { low: 0, moderate: 0, high: 0 };
  for (const p of panels) {
    totalAreaM2 += p.areaM2;
    sunlitAreaM2 += p.areaM2 * (p.annualScore / 100);
    scoreSum += p.annualScore;
    if (p.annualScore < 40) buckets.low++;
    else if (p.annualScore < 75) buckets.moderate++;
    else buckets.high++;
  }
  const avgScore = count ? Math.round(scoreSum / count) : 0;
  const shadedAreaM2 = totalAreaM2 - sunlitAreaM2;
  const lossPercent = totalAreaM2 ? Math.round((100 * shadedAreaM2) / totalAreaM2) : 0;
  return { count, totalAreaM2, sunlitAreaM2, shadedAreaM2, lossPercent, avgScore, buckets };
}

function campusMonthlyAverages() {
  const sums = new Array(12).fill(0);
  for (const p of state.panels) {
    for (let m = 0; m < 12; m++) sums[m] += p.monthlySunlitFraction[m] * 100;
  }
  const n = state.panels.length || 1;
  return sums.map((s) => s / n);
}

function bucketBarHtml(buckets, count) {
  const pct = (n) => (count ? (100 * n) / count : 0);
  return `
    <div class="bucket-bar">
      <span class="bucket-seg" style="width:${pct(buckets.low)}%; background:#d9534f"></span>
      <span class="bucket-seg" style="width:${pct(buckets.moderate)}%; background:#e0a800"></span>
      <span class="bucket-seg" style="width:${pct(buckets.high)}%; background:#2aa876"></span>
    </div>
    <div class="bucket-legend">
      <span>${buckets.low.toLocaleString()} low</span>
      <span>${buckets.moderate.toLocaleString()} moderate</span>
      <span>${buckets.high.toLocaleString()} high</span>
    </div>`;
}

function renderCampusMetrics() {
  const s = summarizePanels(state.panels);
  const el = document.getElementById("campus-metrics");
  el.innerHTML = `
    <div class="metric-row"><span>Panels analyzed</span><span>${s.count.toLocaleString()}</span></div>
    <div class="metric-row"><span>Avg annual score</span><span>${s.avgScore}</span></div>
    <div class="metric-row"><span>Total panel area</span><span>${s.totalAreaM2.toFixed(0)} m²</span></div>
    <div class="metric-row"><span>Sunlit area (annual avg)</span><span>${s.sunlitAreaM2.toFixed(0)} m²</span></div>
    <div class="metric-row"><span>Shaded area (annual avg)</span><span>${s.shadedAreaM2.toFixed(0)} m² (${s.lossPercent}%)</span></div>
    ${bucketBarHtml(s.buckets, s.count)}
  `;
}

function renderSelectionSummary(ids) {
  const btn = document.getElementById("clear-selection-btn");
  const el = document.getElementById("selection-summary");
  if (!ids || !ids.length) {
    el.innerHTML = `<div class="empty">Click a single panel, or turn on Drag-Select and drag a rectangle to select a group.</div>`;
    btn.style.display = "none";
    return;
  }
  const panels = ids.map((id) => state.panelsById.get(id)).filter(Boolean);
  const s = summarizePanels(panels);
  el.innerHTML = `
    <div class="metric-row"><span>Panels selected</span><span>${s.count.toLocaleString()}</span></div>
    <div class="metric-row"><span>Avg annual score</span><span>${s.avgScore}</span></div>
    <div class="metric-row"><span>Total panel area</span><span>${s.totalAreaM2.toFixed(0)} m²</span></div>
    <div class="metric-row"><span>Sunlit area (annual avg)</span><span>${s.sunlitAreaM2.toFixed(0)} m²</span></div>
    <div class="metric-row"><span>Shaded area (annual avg)</span><span>${s.shadedAreaM2.toFixed(0)} m² (${s.lossPercent}%)</span></div>
    ${bucketBarHtml(s.buckets, s.count)}
  `;
  btn.style.display = "block";
}

function drawMonthChart(monthlyAvgScores) {
  const canvas = document.getElementById("month-chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const padL = 4;
  const padR = 4;
  const padT = 6;
  const padB = 16;
  const barW = (w - padL - padR) / 12;

  for (let m = 0; m < 12; m++) {
    const score = monthlyAvgScores[m];
    const barH = ((h - padT - padB) * score) / 100;
    const x = padL + m * barW;
    const y = h - padB - barH;
    const hue = score >= 75 ? "#2aa876" : score >= 40 ? "#e0a800" : "#d9534f";
    ctx.fillStyle = hue;
    ctx.fillRect(x + 1, y, barW - 2, barH);

    ctx.fillStyle = "#93a1ac";
    ctx.font = "9px 'Avenir Next', 'Avenir', monospace";
    ctx.textAlign = "center";
    ctx.fillText(MONTH_ABBR[m], x + barW / 2, h - 4);
  }
}

// ---------------------------------------------------------------------------
// Selection: click a single panel, or turn on Drag-Select and drag a rectangle to select a group.
//
// Deliberately does NOT use view.hitTest() or layer/layerView.queryObjectIds():
// against this layer's ~29.5k individual polygon features, both were found to
// hang the render thread indefinitely in testing. Instead we test clicks and
// drag-rectangles directly against the panel rings/bboxes already held in
// state (computed once at load time) -- a plain JS loop over ~30k tiny
// triangles is sub-millisecond and sidesteps the FeatureLayer query path.
// ---------------------------------------------------------------------------
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findPanelAtPoint(x, y) {
  for (const p of state.panels) {
    const b = p.bbox;
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
    if (pointInRing(x, y, p.ring)) return p.objectId;
  }
  return null;
}

function findPanelsInExtent(xmin, xmax, ymin, ymax) {
  const ids = [];
  for (const p of state.panels) {
    const [cx, cy] = p.centroid; // ringCentroid() returns [lon, lat], not {x, y}
    if (cx >= xmin && cx <= xmax && cy >= ymin && cy <= ymax) ids.push(p.objectId);
  }
  return ids;
}

function setupSelection(view) {
  let dragStartScreen = null;

  view.on("click", (event) => {
    if (state.selectMode) return; // drag-select mode owns clicks-without-movement too; avoid double-handling
    const mapPoint = event.mapPoint;
    if (!mapPoint) return;
    const objectId = findPanelAtPoint(mapPoint.longitude, mapPoint.latitude);
    if (objectId == null) return;
    applySelection([objectId]);
  });

  view.on("drag", (event) => {
    if (!state.selectMode) return; // let default pan/zoom happen otherwise
    event.stopPropagation();
    if (event.action === "start") {
      dragStartScreen = { x: event.x, y: event.y };
    } else if (event.action === "end" && dragStartScreen) {
      const p1 = view.toMap(dragStartScreen);
      const p2 = view.toMap({ x: event.x, y: event.y });
      dragStartScreen = null;
      if (!p1 || !p2) return;
      const xmin = Math.min(p1.longitude, p2.longitude);
      const xmax = Math.max(p1.longitude, p2.longitude);
      const ymin = Math.min(p1.latitude, p2.latitude);
      const ymax = Math.max(p1.latitude, p2.latitude);
      const ids = findPanelsInExtent(xmin, xmax, ymin, ymax);
      applySelection(ids);
    }
  });

  const selectModeBtn = document.getElementById("select-mode-btn");
  selectModeBtn.addEventListener("click", () => {
    state.selectMode = !state.selectMode;
    selectModeBtn.textContent = `Drag-Select: ${state.selectMode ? "On" : "Off"}`;
    selectModeBtn.classList.toggle("active", state.selectMode);
    // Note: directly setting view.container.style.cursor interferes with
    // ArcGIS's internal drag-gesture detection and silently breaks
    // drag-select. Use a CSS class on the map container instead.
    view.container.classList.toggle("select-mode-active", state.selectMode);
  });
}

let activeHighlight = null;
function applySelection(objectIds) {
  if (activeHighlight) {
    activeHighlight.remove();
    activeHighlight = null;
  }
  if (!objectIds || !objectIds.length) {
    state.selectedIds = null;
    renderSelectionSummary(null);
    return;
  }
  state.selectedIds = objectIds;
  activeHighlight = state.layerView.highlight(objectIds);
  renderSelectionSummary(objectIds);
}

function clearSelection() {
  applySelection(null);
}

main().catch((err) => {
  console.error(err);
  document.getElementById("loading-overlay").innerHTML =
    '<div style="color:#d9534f">Failed to load annual heatmap data. See console for details.</div>';
});
