import { getSunPosition, buildSceneDate } from "./solar.js";
import {
  CAMPUS,
  IMAGE_SERVICES,
  FEATURE_SERVICES,
  SNAPSHOT_HOURS,
  REPRESENTATIVE_YEAR,
  MONTHLY_PEAK_SUN_HOURS,
  DAYS_IN_MONTH_2026,
  scoreFieldName,
} from "./data-sources.js";
import { ringCentroid, triangleAreaM2 } from "./geo-utils.js";
import { queryAllFeatures } from "./agol.js";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEFAULT_MONTH_INDEX = 6; // July -- matches the 3D viewer's default demo date
const DEFAULT_HOUR = 14;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  // {objectId, gridId, building, areaM2, ring, centroid, bbox, annualScore, currentScore,
  //  scores[monthIndex][snapshotIndex]}
  panels: [],
  panelsById: new Map(),
  currentMonth: DEFAULT_MONTH_INDEX,
  currentHour: DEFAULT_HOUR,
  view: null,
  panelsLayer: null,
  layerView: null,
  selectedIds: null, // null = no selection (campus-wide totals shown instead)
  selectedBuilding: "",
  selectMode: false, // when true, drag draws a rectangle-select instead of panning
};

async function main() {
  const [Graphic, FeatureLayer, TileLayer, config] = await $arcgis.import([
    "@arcgis/core/Graphic.js",
    "@arcgis/core/layers/FeatureLayer.js",
    "@arcgis/core/layers/TileLayer.js",
    "@arcgis/core/config.js",
  ]);
  state.Graphic = Graphic;

  if (window.ARCGIS_CONFIG?.apiKey && !window.ARCGIS_CONFIG.apiKey.startsWith("YOUR_")) {
    config.apiKey = window.ARCGIS_CONFIG.apiKey;
  } else {
    console.warn(
      "No ArcGIS API key configured. Copy config.example.js to config.js and add your key."
    );
  }

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

  // ---- Load panel geometry + the 60 S_<MM>_<HH> score fields + Building, live from the
  // hosted AGOL feature layer (FEATURE_SERVICES.solarPanelsAnnual -- the same "_v2" service
  // the 3D viewer uses) -- NOT the local data/solar_tessellation_3d.geojson +
  // shadow_obstruction_annual.bin files this page used to fetch previously.
  const outFields = ["SRC_OBJECTID", "GRID_ID", "Building"];
  for (let m = 1; m <= 12; m++) {
    for (const hour of SNAPSHOT_HOURS) outFields.push(scoreFieldName(m - 1, hour));
  }
  const features = await queryAllFeatures(FEATURE_SERVICES.solarPanelsAnnual, outFields);

  const graphics = buildPanelGraphics(features, Graphic);
  state.panelsLayer = new FeatureLayer({
    title: "Solar Panels (annual exposure)",
    source: graphics,
    objectIdField: "OBJECTID",
    geometryType: "polygon",
    spatialReference: { wkid: 4326 },
    fields: [
      { name: "OBJECTID", type: "oid" },
      { name: "GRID_ID", type: "string" },
      { name: "score", type: "integer" },
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

  setupTimeControls();
  setupChartClicks();
  setupBuildingSelect();
  setupSelection(view);
  document.getElementById("clear-selection-btn").addEventListener("click", clearSelection);

  setTime(state.currentHour); // computes scores for the default month/hour + renders everything

  // Only hide (and clear the stale "Computing..." text) once the metrics/chart render
  // from setTime() above has actually completed, so nothing stale is left behind.
  hideLoadingOverlay();
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("loading-overlay");
  overlay.classList.add("hidden");
  overlay.textContent = "";
}

// ---------------------------------------------------------------------------
// Panel construction
// ---------------------------------------------------------------------------
// `features` are raw Esri JSON query results (attributes + geometry.rings) from
// FEATURE_SERVICES.solarPanelsAnnual, not GeoJSON -- mirrors js/app.js's
// buildPanelGraphics(), but flat/2D (no Z kept on the rendered geometry; this is a map
// page, not a 3D scene) and keyed by the live "Building" attribute instead.
function buildPanelGraphics(features, Graphic) {
  const graphics = [];
  for (const f of features) {
    const ring = f.geometry?.rings?.[0];
    if (!ring || ring.length < 4) continue;
    const attrs = f.attributes;
    const objectId = attrs.SRC_OBJECTID;
    // triangleAreaM2() needs real Z for true 3D surface area -- read it from the raw ring
    // before flattening.
    const areaM2 = triangleAreaM2(ring);

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

    // scores[monthIndex][snapshotIndex] -- the 60 published S_<MM>_<HH> fields, read once
    // up front and indexed for fast per-tick lookup (see recomputeAllPanelScores()).
    const scores = [];
    for (let m = 0; m < 12; m++) {
      scores.push(SNAPSHOT_HOURS.map((hour) => attrs[scoreFieldName(m, hour)] ?? 0));
    }

    const building = attrs.Building && String(attrs.Building).trim() ? String(attrs.Building).trim() : null;

    const panel = {
      objectId,
      gridId: attrs.GRID_ID,
      building,
      areaM2,
      ring: flatRing,
      centroid,
      bbox: { minX, maxX, minY, maxY },
      currentScore: 50,
      scores,
      annualScore: annualScoreForPanel(scores),
    };
    state.panels.push(panel);
    state.panelsById.set(objectId, panel);
    graphics.push(
      new Graphic({
        geometry: { type: "polygon", rings: [flatRing], spatialReference: { wkid: 4326 } },
        attributes: { OBJECTID: objectId, GRID_ID: attrs.GRID_ID, score: panel.currentScore },
      })
    );
  }
  return graphics;
}

/** Rolls one panel's 12x5 published S_<MM>_<HH> scores up into a single annual figure,
 * weighted by MONTHLY_PEAK_SUN_HOURS (a rough seasonal insolation *shape*, NOT measured
 * data -- see data-sources.js) and DAYS_IN_MONTH_2026. Each representative day's score is
 * the plain average of its 5 published snapshot scores. Purely a 0-100 figure, with no area
 * or wattage assumption anywhere in the math. */
function annualScoreForPanel(scores) {
  let weightedSum = 0;
  let weightSum = 0;
  for (let m = 0; m < 12; m++) {
    const dayAvg = scores[m].reduce((sum, s) => sum + s, 0) / scores[m].length;
    const weight = MONTHLY_PEAK_SUN_HOURS[m] * DAYS_IN_MONTH_2026[m];
    weightedSum += dayAvg * weight;
    weightSum += weight;
  }
  return weightSum ? Math.round(weightedSum / weightSum) : 0;
}

// Continuous red -> amber -> green color ramp driven by each panel's "score" attribute
// (0-100), for a true heatmap look rather than 3 discrete buckets.
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
        field: "score",
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
// Time + month controls (mirrors js/app.js's setTime()/recomputeAllPanelScores(), applied
// to this page's own panels/FeatureLayer instead of the 3D viewer's).
// ---------------------------------------------------------------------------
function setupTimeControls() {
  const slider = document.getElementById("time-slider");
  slider.addEventListener("input", (e) => setTime(parseFloat(e.target.value)));
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hour = parseFloat(btn.dataset.hour);
      slider.value = String(hour);
      setTime(hour);
    });
  });

  const monthSelect = document.getElementById("month-select");
  monthSelect.value = String(state.currentMonth);
  monthSelect.addEventListener("change", (e) => {
    state.currentMonth = parseInt(e.target.value, 10);
    setTime(state.currentHour);
  });
}

function setTime(hour) {
  state.currentHour = hour;
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.classList.toggle("active", Math.abs(parseFloat(btn.dataset.hour) - hour) < 0.01);
  });
  document.getElementById("time-label").textContent = formatHour(hour);

  const datePart = currentDatePart();
  const date = buildSceneDate(datePart, hour, CAMPUS.utcOffset);
  const sun = getSunPosition(date, CAMPUS.lat, CAMPUS.lon);

  const sunStateEl = document.getElementById("sun-state");
  const sunReadout = document.getElementById("sun-readout");
  if (sun.altitude <= 0.5) {
    sunStateEl.textContent = "🌙 Below horizon";
    sunReadout.textContent = "No direct sunlight at this hour.";
  } else {
    sunStateEl.textContent = "☀️";
    sunReadout.textContent = `Sun altitude ${sun.altitude.toFixed(1)}° · azimuth ${sun.azimuth.toFixed(
      1
    )}°`;
  }

  recomputeAllPanelScores();
  renderCampusMetrics();
  renderSelectionSummary(state.selectedIds);
}

function formatHour(hour) {
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  const period = whole >= 12 ? "PM" : "AM";
  let h12 = whole % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(minutes).padStart(2, "0")} ${period}`;
}

/** The YYYY-MM-DD date string for the currently selected month -- the 15th of
 * REPRESENTATIVE_YEAR, matching the published score fields. */
function currentDatePart() {
  const mm = String(state.currentMonth + 1).padStart(2, "0");
  return `${REPRESENTATIVE_YEAR}-${mm}-15`;
}

/** Index of `hour` within SNAPSHOT_HOURS, e.g. snapshotIndex(12) -> 2 (noon). Falls back to
 * the nearest published hour if called with something else (shouldn't happen now that the
 * slider is restricted to SNAPSHOT_HOURS). */
function snapshotIndex(hour) {
  const exact = SNAPSHOT_HOURS.indexOf(hour);
  if (exact !== -1) return exact;
  let best = 0;
  for (let i = 1; i < SNAPSHOT_HOURS.length; i++) {
    if (Math.abs(SNAPSHOT_HOURS[i] - hour) < Math.abs(SNAPSHOT_HOURS[best] - hour)) best = i;
  }
  return best;
}

function recomputeAllPanelScores() {
  const hi = snapshotIndex(state.currentHour);
  const updateFeatures = [];
  for (const panel of state.panels) {
    const score = panel.scores[state.currentMonth][hi];
    panel.currentScore = score;
    updateFeatures.push(new state.Graphic({ attributes: { OBJECTID: panel.objectId, score } }));
  }
  // One batched edit for all panels -- the renderer recolors itself from the updated
  // "score" attribute (see heatmapRenderer()), so this never touches symbol objects.
  state.panelsLayer.applyEdits({ updateFeatures });
}

// ---------------------------------------------------------------------------
// Campus-wide + selection metrics
// ---------------------------------------------------------------------------
// Reads each panel's *currently selected* month+hour score (panel.currentScore, kept in
// sync by recomputeAllPanelScores() on every time/month change) rather than a fixed annual
// average, so these figures reflect the exact snapshot the user has dialed in.
function summarizePanels(panels) {
  const count = panels.length;
  let totalAreaM2 = 0;
  let sunlitAreaM2 = 0;
  let scoreSum = 0;
  let annualScoreSum = 0;
  const buckets = { low: 0, moderate: 0, high: 0 }; // area (m²) per score bucket, not panel counts
  for (const p of panels) {
    totalAreaM2 += p.areaM2;
    sunlitAreaM2 += p.areaM2 * (p.currentScore / 100);
    scoreSum += p.currentScore;
    annualScoreSum += p.annualScore;
    if (p.currentScore < 40) buckets.low += p.areaM2;
    else if (p.currentScore < 75) buckets.moderate += p.areaM2;
    else buckets.high += p.areaM2;
  }
  const avgScore = count ? Math.round(scoreSum / count) : 0;
  const avgAnnualScore = count ? Math.round(annualScoreSum / count) : 0;
  const shadedAreaM2 = totalAreaM2 - sunlitAreaM2;
  const lossPercent = totalAreaM2 ? Math.round((100 * shadedAreaM2) / totalAreaM2) : 0;
  return { count, totalAreaM2, sunlitAreaM2, shadedAreaM2, lossPercent, avgScore, avgAnnualScore, buckets };
}

/** Per-month average of the representative day's score (plain mean of the 5 published
 * snapshot hours), across the given panels -- the "annual shape" chart's data. */
function monthlyAverages(panels) {
  const sums = new Array(12).fill(0);
  for (const p of panels) {
    for (let m = 0; m < 12; m++) {
      const dayScores = p.scores[m];
      sums[m] += dayScores.reduce((sum, s) => sum + s, 0) / dayScores.length;
    }
  }
  const n = panels.length || 1;
  return sums.map((s) => s / n);
}

/** Per-snapshot-hour average score for the currently selected month, across the given
 * panels -- the "day profile" chart's data. */
function dayProfileAverages(panels) {
  const sums = new Array(SNAPSHOT_HOURS.length).fill(0);
  for (const p of panels) {
    const dayScores = p.scores[state.currentMonth];
    for (let i = 0; i < dayScores.length; i++) sums[i] += dayScores[i];
  }
  const n = panels.length || 1;
  return sums.map((s) => s / n);
}

/** Renders the low/moderate/high breakdown by area (m²), not panel count -- the visual bar
 * width is each bucket's share of totalAreaM2, and the legend prints each bucket's summed
 * panel area. */
function bucketBarHtml(buckets, totalAreaM2) {
  const pct = (areaM2) => (totalAreaM2 ? (100 * areaM2) / totalAreaM2 : 0);
  return `
    <div class="bucket-bar">
      <span class="bucket-seg" style="width:${pct(buckets.low)}%; background:#d9534f"></span>
      <span class="bucket-seg" style="width:${pct(buckets.moderate)}%; background:#e0a800"></span>
      <span class="bucket-seg" style="width:${pct(buckets.high)}%; background:#2aa876"></span>
    </div>
    <div class="bucket-legend">
      <span>${buckets.low.toFixed(0)} m² low</span>
      <span>${buckets.moderate.toFixed(0)} m² moderate</span>
      <span>${buckets.high.toFixed(0)} m² high</span>
    </div>`;
}

function metricsHtml(s, label, { showCount = true } = {}) {
  const countRow = showCount
    ? `<div class="metric-row"><span>${label}</span><span>${s.count.toLocaleString()}</span></div>`
    : "";
  return `
    ${countRow}
    <div class="metric-row"><span>Score (this snapshot)</span><span>${s.avgScore}</span></div>
    <div class="metric-row"><span>Annual avg</span><span>${s.avgAnnualScore}</span></div>
    <div class="metric-row"><span>Total panel area</span><span>${s.totalAreaM2.toFixed(0)} m²</span></div>
    <div class="metric-row"><span>Sunlit area (this snapshot)</span><span>${s.sunlitAreaM2.toFixed(0)} m²</span></div>
    <div class="metric-row"><span>Shaded area (this snapshot)</span><span>${s.shadedAreaM2.toFixed(0)} m² (${s.lossPercent}%)</span></div>
    ${bucketBarHtml(s.buckets, s.totalAreaM2)}
  `;
}

function activePanels() {
  return state.selectedIds ? state.selectedIds.map((id) => state.panelsById.get(id)).filter(Boolean) : state.panels;
}

function renderCampusMetrics() {
  const s = summarizePanels(state.panels);
  document.getElementById("campus-metrics").innerHTML = metricsHtml(s, "Panels analyzed", { showCount: false });
  drawDayChart(dayProfileAverages(activePanels()));
  drawMonthChart(monthlyAverages(activePanels()));
}

function renderSelectionSummary(ids) {
  const btn = document.getElementById("clear-selection-btn");
  const el = document.getElementById("selection-summary");
  if (!ids || !ids.length) {
    el.innerHTML = `<div class="empty">Click a single panel, or turn on Select Tool and drag a rectangle to select a group.</div>`;
    btn.style.display = "none";
  } else {
    const panels = ids.map((id) => state.panelsById.get(id)).filter(Boolean);
    const s = summarizePanels(panels);
    el.innerHTML = metricsHtml(s, "Panels selected");
    btn.style.display = "block";
  }
  drawDayChart(dayProfileAverages(activePanels()));
  drawMonthChart(monthlyAverages(activePanels()));
}

function drawMonthChart(monthlyAvgScores) {
  const canvas = document.getElementById("month-chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const padL = CHART_PAD_L;
  const padR = CHART_PAD_R;
  const padT = 6;
  const padB = 16;
  const barW = (w - padL - padR) / 12;

  for (let m = 0; m < 12; m++) {
    const score = monthlyAvgScores[m];
    const barH = ((h - padT - padB) * score) / 100;
    const x = padL + m * barW;
    const y = h - padB - barH;
    const isSelected = m === state.currentMonth;
    ctx.fillStyle = score >= 75 ? "#2aa876" : score >= 40 ? "#e0a800" : "#d9534f";
    ctx.globalAlpha = isSelected ? 1 : 0.55;
    ctx.fillRect(x + 1, y, barW - 2, barH);
    ctx.globalAlpha = 1;

    ctx.fillStyle = isSelected ? "#fff" : "#93a1ac";
    ctx.font = "9px 'Avenir Next', 'Avenir', monospace";
    ctx.textAlign = "center";
    ctx.fillText(MONTH_ABBR[m], x + barW / 2, h - 4);
  }
}

/** Day-shape chart for the currently selected month: one bar per published snapshot hour
 * (8/10/noon/2/4), highlighting whichever hour is currently dialed in on the time-slider.
 * Redrawn on every month/time/selection change -- see renderCampusMetrics()/
 * renderSelectionSummary(). */
function drawDayChart(hourAvgScores) {
  const canvas = document.getElementById("day-chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const padL = CHART_PAD_L;
  const padR = CHART_PAD_R;
  const padT = 6;
  const padB = 16;
  const n = SNAPSHOT_HOURS.length;
  const barW = (w - padL - padR) / n;
  const hi = snapshotIndex(state.currentHour);

  for (let i = 0; i < n; i++) {
    const score = hourAvgScores[i];
    const barH = ((h - padT - padB) * score) / 100;
    const x = padL + i * barW;
    const y = h - padB - barH;
    const isSelected = i === hi;
    ctx.fillStyle = score >= 75 ? "#2aa876" : score >= 40 ? "#e0a800" : "#d9534f";
    ctx.globalAlpha = isSelected ? 1 : 0.55;
    ctx.fillRect(x + 1, y, barW - 2, barH);
    ctx.globalAlpha = 1;

    if (isSelected) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + barW / 2, padT);
      ctx.lineTo(x + barW / 2, h - padB);
      ctx.stroke();
    }

    ctx.fillStyle = isSelected ? "#fff" : "#93a1ac";
    ctx.font = "9px 'Avenir Next', 'Avenir', monospace";
    ctx.textAlign = "center";
    ctx.fillText(formatHour(SNAPSHOT_HOURS[i]).replace(":00 ", " "), x + barW / 2, h - 4);
  }
}

/** Shared bar-geometry constants so click handlers can map an x-coordinate back to the
 * exact bar index drawMonthChart()/drawDayChart() rendered it at. */
const CHART_PAD_L = 4;
const CHART_PAD_R = 4;

function setupChartClicks() {
  const dayCanvas = document.getElementById("day-chart");
  dayCanvas.addEventListener("click", (e) => {
    const i = barIndexFromClick(e, dayCanvas, SNAPSHOT_HOURS.length);
    if (i == null) return;
    const hour = SNAPSHOT_HOURS[i];
    document.getElementById("time-slider").value = String(hour);
    setTime(hour);
  });

  const monthCanvas = document.getElementById("month-chart");
  monthCanvas.addEventListener("click", (e) => {
    const m = barIndexFromClick(e, monthCanvas, 12);
    if (m == null) return;
    state.currentMonth = m;
    document.getElementById("month-select").value = String(m);
    setTime(state.currentHour);
  });
}

/** Converts a canvas click event into the index of the bar it landed on, using the same
 * padL/padR/barW math drawMonthChart()/drawDayChart() use to position bars. Returns null
 * if the click landed outside the bar area. */
function barIndexFromClick(event, canvas, barCount) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const x = (event.clientX - rect.left) * scaleX;
  const barW = (canvas.width - CHART_PAD_L - CHART_PAD_R) / barCount;
  const i = Math.floor((x - CHART_PAD_L) / barW);
  if (i < 0 || i >= barCount) return null;
  return i;
}

// ---------------------------------------------------------------------------
// Building selector
// ---------------------------------------------------------------------------
function setupBuildingSelect() {
  const select = document.getElementById("building-select");
  const buildings = [...new Set(state.panels.map((p) => p.building).filter(Boolean))].sort();
  for (const b of buildings) {
    const opt = document.createElement("option");
    opt.value = b;
    opt.textContent = b;
    select.appendChild(opt);
  }
  select.addEventListener("change", (e) => {
    state.selectedBuilding = e.target.value;
    if (!state.selectedBuilding) {
      applySelection(null);
      return;
    }
    const ids = state.panels.filter((p) => p.building === state.selectedBuilding).map((p) => p.objectId);
    applySelection(ids);
  });
}

// ---------------------------------------------------------------------------
// Selection: click a single panel, or turn on Select Tool and drag a rectangle to select a group.
//
// Deliberately does NOT use view.hitTest() or layer/layerView.queryObjectIds():
// against this layer's thousands of individual polygon features, both were found to
// hang the render thread indefinitely in testing. Instead we test clicks and
// drag-rectangles directly against the panel rings/bboxes already held in
// state (computed once at load time) -- a plain JS loop over small triangles is
// sub-millisecond and sidesteps the FeatureLayer query path.
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

  // Visible rectangle overlay that tracks the drag in real time. IMPORTANT: this must NOT
  // be appended to view.container -- that element lives inside the <arcgis-map> web
  // component's Shadow DOM, where page-level CSS (css/style.css) can't reach it. A plain
  // <div> dropped there falls back to the browser default `position: static` and gets laid
  // out as a real flex/grid child of Esri's internal view-root layout, which visibly
  // squeezes/crops the actual map (this was the "cropping the view" bug). Instead, append
  // it to the light-DOM #app wrapper (where our CSS does apply) and translate the drag
  // event's view.container-relative x/y into #app-relative coordinates via the live
  // bounding-rect offset between the two -- they aren't guaranteed to share an origin.
  const overlayParent = document.getElementById("app");
  const selectBox = document.createElement("div");
  selectBox.id = "select-box";
  overlayParent.appendChild(selectBox);

  function viewContainerOffset() {
    const vRect = view.container.getBoundingClientRect();
    const pRect = overlayParent.getBoundingClientRect();
    return { dx: vRect.left - pRect.left, dy: vRect.top - pRect.top };
  }

  function updateSelectBox(p1, p2) {
    const offset = viewContainerOffset();
    selectBox.style.left = `${Math.min(p1.x, p2.x) + offset.dx}px`;
    selectBox.style.top = `${Math.min(p1.y, p2.y) + offset.dy}px`;
    selectBox.style.width = `${Math.abs(p2.x - p1.x)}px`;
    selectBox.style.height = `${Math.abs(p2.y - p1.y)}px`;
  }

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
      updateSelectBox(dragStartScreen, dragStartScreen);
      selectBox.style.display = "block";
    } else if (event.action === "update" && dragStartScreen) {
      updateSelectBox(dragStartScreen, { x: event.x, y: event.y });
    } else if (event.action === "end" && dragStartScreen) {
      const p1 = view.toMap(dragStartScreen);
      const p2 = view.toMap({ x: event.x, y: event.y });
      dragStartScreen = null;
      selectBox.style.display = "none";
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
    selectModeBtn.textContent = `Select Tool: ${state.selectMode ? "On" : "Off"}`;
    selectModeBtn.classList.toggle("active", state.selectMode);
    // Note: directly setting view.container.style.cursor interferes with
    // ArcGIS's internal drag-gesture detection and silently breaks
    // drag-select. Use a CSS class on the map container instead.
    view.container.classList.toggle("select-mode-active", state.selectMode);
    if (!state.selectMode) {
      dragStartScreen = null;
      selectBox.style.display = "none";
    }
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
  const buildingSelect = document.getElementById("building-select");
  if (buildingSelect) buildingSelect.value = "";
  state.selectedBuilding = "";
  applySelection(null);
}

main().catch((err) => {
  console.error(err);
  document.getElementById("loading-overlay").innerHTML =
    '<div style="color:#d9534f">Failed to load annual heatmap data. See console for details.</div>';
});
