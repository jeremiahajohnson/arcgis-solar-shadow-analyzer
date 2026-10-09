import { getSunPosition, buildSceneDate } from "./solar.js";
import {
  CAMPUS,
  PORTAL_ITEMS,
  FEATURE_SERVICES,
  IMAGE_SERVICES,
  SNAPSHOT_HOURS,
  REPRESENTATIVE_YEAR,
  scoreFieldName,
} from "./data-sources.js";
import { ringCentroid, triangleAreaM2 } from "./geo-utils.js";

// Human-readable labels for the 12 representative days (15th of each month) baked into the
// published solar exposure score fields (see data-sources.js FEATURE_SERVICES.solarPanelsAnnual
// and elevation/build_annual_exposure_fields.py).
const MONTH_LABELS = [
  "January 15",
  "February 15",
  "March 15",
  "April 15",
  "May 15",
  "June 15",
  "July 15",
  "August 15",
  "September 15",
  "October 15",
  "November 15",
  "December 15",
];
const DEFAULT_MONTH_INDEX = 6; // July -- matches the original single-day demo date

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  // {id, objectId, panelId, areaM2, lon, lat, currentScore, scores}
  // scores[monthIndex][snapshotIndex] = published 0-100 exposure score (see
  // FEATURE_SERVICES.solarPanelsAnnual / SNAPSHOT_HOURS) -- loaded once up front.
  panels: [],
  panelsById: new Map(),
  currentMonth: DEFAULT_MONTH_INDEX,
  currentHour: 14,
  currentSun: { altitude: 0, azimuth: 0 },
  selected: null, // { kind: "panel", id }
  view: null,
  highlightHandle: null,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function main() {
  const [
    Graphic,
    FeatureLayer,
    TileLayer,
    GaussianSplatLayer,
    config,
  ] = await $arcgis.import([
    "@arcgis/core/Graphic.js",
    "@arcgis/core/layers/FeatureLayer.js",
    "@arcgis/core/layers/TileLayer.js",
    "@arcgis/core/layers/GaussianSplatLayer.js",
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

  const sceneEl = document.getElementById("scene");
  await sceneEl.viewOnReady();
  const view = sceneEl.view;
  state.view = view;

  view.environment.lighting.directionalShadowsEnabled = true;
  view.environment.atmosphereEnabled = true;
  view.qualityProfile = "high";

  // Keep the world elevation service active (so layers continue to drape/position
  // correctly), but hide the visible terrain surface itself -- the Gaussian Splat,
  // orthomosaic, and DSM layers already cover the ground visually.
  view.map.ground.opacity = 0;

  // ---- Reference layers ---------------------------------------------------
  const trueOrtho = new TileLayer({
    url: IMAGE_SERVICES.trueOrtho,
    title: "True Orthomosaic",
    opacity: 1,
  });
  const footprint = new FeatureLayer({
    url: FEATURE_SERVICES.buildingFootprint,
    title: "Building Footprint",
    opacity: 0.35,
    renderer: {
      type: "simple",
      symbol: {
        type: "polygon-3d",
        symbolLayers: [
          {
            type: "fill",
            material: { color: [255, 255, 255, 0.25] },
            outline: { color: [255, 255, 255, 0.9], size: 1.5 },
          },
        ],
      },
    },
    elevationInfo: { mode: "on-the-ground" },
  });
  // Not added to the scene or layer toggles -- the Gaussian Splat / true ortho
  // already render the buildings. Kept loaded only to derive the campus extent
  // used to frame the initial camera below.

  const gaussianSplat = new GaussianSplatLayer({
    portalItem: { id: PORTAL_ITEMS.gaussianSplat },
    title: "Gaussian Splat",
  });

  // ---- Load real asset data ------------------------------------------------
  // Solar panel geometry + the 60 precomputed exposure-score fields (12 representative
  // days x 5 times of day) now come live from the published AGOL hosted feature layer
  // (see FEATURE_SERVICES.solarPanelsAnnual) instead of local
  // data/solar_tessellation_3d.geojson + data/shadow_obstruction_annual.bin.
  const [solarPanelFeatures, footprintFeatures] = await Promise.all([
    queryAllFeatures(FEATURE_SERVICES.solarPanelsAnnual),
    footprint.load().then(() => footprint.queryExtent()),
  ]);

  // Solar panels are now the DSM-enriched, campus-wide tessellation triangles rather than
  // the old Building_E_Extracted_Solar_Panels service, which only covered one building.
  // At ~30,000 features, a plain GraphicsLayer (one Graphic + one symbol object per
  // triangle, individually reassigned on every time-of-day change) is catastrophically
  // slow -- it froze the tab for minutes. A client-side FeatureLayer instead renders all
  // features through a single shared, data-driven renderer (score -> color via
  // class-breaks) and batch-updates scores via one applyEdits() call per tick, which is
  // the scale this feature count actually requires.
  const graphics = buildPanelGraphics(solarPanelFeatures, Graphic);
  const subtitleEl = document.getElementById("subtitle");
  if (subtitleEl) {
    subtitleEl.textContent = `Esri Redlands Campus digital twin. Drone-derived Gaussian Splat and true ortho, with a campus-wide 0.5m solar tessellation (${state.panels.length.toLocaleString()} triangles, vegetation-spikes filtered out), scored from a published ArcGIS Online hosted feature layer.`;
  }
  const panelsLayer = new FeatureLayer({
    title: "Solar Panels",
    source: graphics,
    objectIdField: "OBJECTID",
    geometryType: "polygon",
    spatialReference: { wkid: 4326 },
    fields: [
      { name: "OBJECTID", type: "oid" },
      { name: "GRID_ID", type: "string" },
      { name: "score", type: "integer" },
    ],
    elevationInfo: { mode: "absolute-height", offset: 0.15 },
    renderer: scoreRenderer(),
  });
  state.panelsLayer = panelsLayer;

  view.map.addMany([
    trueOrtho,
    gaussianSplat,
    panelsLayer,
  ]);

  setupLayerToggles([
    { layer: gaussianSplat, label: "Gaussian Splat", defaultOn: true },
    { layer: trueOrtho, label: "True Orthomosaic", defaultOn: true },
    {
      layer: panelsLayer,
      label: "Solar Panels",
      defaultOn: true,
    },
  ]);

  // Frame the camera on the campus extent.
  if (footprintFeatures?.extent) {
    const extent = footprintFeatures.extent.clone().expand(3);
    await view.goTo({ target: extent, tilt: 62, heading: 20 }, { animate: false });
  } else {
    await view.goTo(
      {
        target: { x: CAMPUS.lon, y: CAMPUS.lat, z: 60, spatialReference: { wkid: 4326 } },
        tilt: 62,
        heading: 20,
      },
      { animate: false }
    );
  }

  // ---- Time-of-day control --------------------------------------------------
  const slider = document.getElementById("time-slider");
  slider.addEventListener("input", (e) => setTime(parseFloat(e.target.value)));
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hour = parseFloat(btn.dataset.hour);
      slider.value = String(hour);
      setTime(hour);
    });
  });

  // ---- Month-of-year control (12 representative days, one per month) --------
  const monthSelect = document.getElementById("month-select");
  monthSelect.value = String(state.currentMonth);
  monthSelect.addEventListener("change", (e) => {
    state.currentMonth = parseInt(e.target.value, 10);
    setTime(state.currentHour);
  });

  // ---- Selection ------------------------------------------------------------
  view.on("click", async (event) => {
    const hit = await view.hitTest(event, { include: [panelsLayer] });
    const result = hit.results.find((r) => r.graphic);
    if (!result) return;
    const g = result.graphic;
    if (g.layer === panelsLayer) selectPanel(`p${g.attributes.OBJECTID}`);
  });

  setTime(state.currentHour);
  document.getElementById("loading-overlay").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Data loading helpers
// ---------------------------------------------------------------------------

// Each "panel" is now one 0.5m solar tessellation triangle: DSM-enriched (each vertex's Z
// sampled from the drone DSM, see elevation/enrich_elevation.py) and campus-wide, with
// vegetation-overhang triangles already filtered out (see
// elevation/filter_tessellation_spikes.py). Unlike the old Building E service, these
// features carry no PanelID/WattHours attributes. We also don't have real panel spec
// sheets (wattage, nameplate efficiency, etc.), so every metric here is area-based instead
// of an energy-production estimate: each triangle's true 3D surface area is the measured
// quantity, split into sunlit/shaded portions by the real DSM-derived exposure score.
//
// Rendering note: at ~29,600 features, individually z-enabled (per-vertex, non-planar)
// polygon-3d geometry is far too expensive -- the 3D engine must build a unique mesh per
// feature, which froze the tab for minutes even via a client-side FeatureLayer. Tilt is
// also imperceptible at the 0.5m triangle scale, so each ring is kept flat/planar -- but it
// IS given a single constant Z (the triangle's mean DSM-sampled vertex elevation) and drawn
// with elevationInfo "absolute-height" rather than "relative-to-scene". This matters: with
// "relative-to-scene", a flat 2D ring drapes onto whatever 3D content is currently visible
// at that lon/lat (e.g. the Gaussian Splat's real tree-canopy geometry), which is what
// produced tall floating "witch hat" spikes over vegetation regardless of how clean the
// underlying Z data was -- the geometry's own Z was being dropped/ignored entirely. Baking
// in an absolute elevation keeps each flat ring (same cheap complexity as before) pinned to
// its real DSM-sampled roof height, independent of which mesh/splat layers are toggled on.
//
// Returns the Graphic array used as the client-side FeatureLayer's `source`; also
// populates state.panels/state.panelsById with the plain-data objects the shadow/scoring
// math reads and writes every tick. `features` are raw Esri JSON query results from the
// published hosted feature layer (attributes + geometry.rings), not GeoJSON.
function buildPanelGraphics(features, Graphic) {
  const graphics = [];
  for (const f of features) {
    const ring = f.geometry?.rings?.[0];
    if (!ring || ring.length < 4) continue;
    const attrs = f.attributes;
    const objectId = attrs.SRC_OBJECTID;
    const id = `p${objectId}`;
    const [lon, lat] = ringCentroid(ring);
    const areaM2 = triangleAreaM2(ring);
    // Flatten to a planar ring (cheap to render) but keep a single real elevation -- the
    // triangle's mean DSM-sampled vertex Z -- so the polygon is pinned at its true roof
    // height instead of draping onto whatever 3D content is visible below it. See the
    // rendering note above.
    const uniqueVerts = ring.slice(0, -1);
    const meanZ = uniqueVerts.reduce((sum, v) => sum + v[2], 0) / uniqueVerts.length;
    const flatRing = ring.map(([x, y]) => [x, y, meanZ]);

    const graphic = new Graphic({
      geometry: {
        type: "polygon",
        rings: [flatRing],
        hasZ: true,
        spatialReference: { wkid: 4326 },
      },
      attributes: { OBJECTID: objectId, GRID_ID: attrs.GRID_ID, score: 50 },
    });
    graphics.push(graphic);

    // scores[monthIndex][snapshotIndex] -- the 60 published S_<MM>_<HH> fields, read once
    // up front and indexed for fast per-tick lookup (see recomputeAllPanelScores()).
    const scores = [];
    for (let m = 0; m < 12; m++) {
      scores.push(SNAPSHOT_HOURS.map((hour) => attrs[scoreFieldName(m, hour)] ?? 0));
    }

    const panel = {
      id,
      objectId,
      panelId: attrs.GRID_ID,
      areaM2,
      lon,
      lat,
      currentScore: 50,
      scores,
    };
    state.panels.push(panel);
    state.panelsById.set(id, panel);
  }
  return graphics;
}

// Pages through the hosted feature layer's query endpoint (maxRecordCount-limited) to
// fetch every feature's geometry + all S_<MM>_<HH> score fields. Uses the ArcGIS Maps SDK's
// own request layer so the already-configured esriConfig.apiKey is applied automatically.
async function queryAllFeatures(serviceUrl) {
  const [FeatureLayer] = await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js"]);
  const layer = new FeatureLayer({ url: serviceUrl });
  await layer.load();
  const pageSize = layer.capabilities?.query?.maxRecordCount || 2000;
  const outFields = ["SRC_OBJECTID", "GRID_ID"];
  for (let m = 1; m <= 12; m++) {
    for (const hour of SNAPSHOT_HOURS) {
      outFields.push(scoreFieldName(m - 1, hour));
    }
  }

  const all = [];
  let start = 0;
  for (;;) {
    const result = await layer.queryFeatures({
      where: "1=1",
      outFields,
      returnGeometry: true,
      returnZ: true,
      // The hosted service's native spatial reference is Web Mercator -- without this,
      // queryFeatures() returns rings in meters, which buildPanelGraphics() would then
      // misinterpret as WGS84 lon/lat degrees (placing every panel off in nowhere).
      outSpatialReference: { wkid: 4326 },
      num: pageSize,
      start,
    });
    for (const g of result.features) {
      all.push({ attributes: g.attributes, geometry: g.geometry ? { rings: g.geometry.rings } : null });
    }
    if (result.features.length < pageSize) break;
    start += pageSize;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Symbology
// ---------------------------------------------------------------------------
function scoreColor(score) {
  if (score >= 75) return [42, 168, 118, 0.9]; // green
  if (score >= 40) return [224, 168, 0, 0.9]; // amber
  return [217, 83, 79, 0.9]; // red
}

function scorePolygonSymbol(score) {
  return {
    type: "polygon-3d",
    symbolLayers: [
      {
        type: "fill",
        material: { color: scoreColor(score) },
        outline: { color: [20, 20, 20, 0.6], size: 0.5 },
      },
    ],
  };
}

function scoreClass(score) {
  if (score >= 75) return "score-high";
  if (score >= 40) return "score-mid";
  return "score-low";
}

// Data-driven renderer: color comes from each feature's "score" attribute via class
// breaks, so live re-scoring only needs to change that one numeric attribute (via a
// single batched applyEdits() call) -- never reconstruct/reassign tens of thousands of
// symbol objects.
function scoreRenderer() {
  return {
    type: "class-breaks",
    field: "score",
    defaultSymbol: scorePolygonSymbol(50),
    classBreakInfos: [
      { minValue: 0, maxValue: 39.999, symbol: scorePolygonSymbol(20) },
      { minValue: 40, maxValue: 74.999, symbol: scorePolygonSymbol(50) },
      { minValue: 75, maxValue: 100, symbol: scorePolygonSymbol(90) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Time + live scoring
// ---------------------------------------------------------------------------
function setTime(hour) {
  state.currentHour = hour;
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.classList.toggle("active", Math.abs(parseFloat(btn.dataset.hour) - hour) < 0.01);
  });
  document.getElementById("time-label").textContent = formatHour(hour);

  const datePart = currentDatePart();
  const date = buildSceneDate(datePart, hour, CAMPUS.utcOffset);
  state.view.environment.lighting.date = date;

  const sun = getSunPosition(date, CAMPUS.lat, CAMPUS.lon);
  state.currentSun = sun;

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
  refreshDetailsPanel();
}

function formatHour(hour) {
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  const period = whole >= 12 ? "PM" : "AM";
  let h12 = whole % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(minutes).padStart(2, "0")} ${period}`;
}

/** The YYYY-MM-DD date string for a given 0-based month index (defaults to the currently
 * selected month) -- the 15th of REPRESENTATIVE_YEAR, matching the published score fields. */
function currentDatePart(monthIndex = state.currentMonth) {
  const mm = String(monthIndex + 1).padStart(2, "0");
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
  // One batched edit for all ~29,600 panels -- the renderer recolors itself from the
  // updated "score" attribute (see scoreRenderer()), so this never touches symbol objects.
  state.panelsLayer.applyEdits({ updateFeatures });
}

// ---------------------------------------------------------------------------
// Daily aggregates (computed on demand -- not every frame)
// ---------------------------------------------------------------------------
// With only 5 published snapshots/day (vs. the ~20+ continuous ray-cast samples the old
// local-binary pipeline provided), this is a coarser approximation: daily sunlight % is the
// straight average of the day's 5 scores, and shadowed-hours treats each snapshot as
// representing its surrounding 2-hour block.
function dailyAggregateForPanel(panel) {
  const dayScores = panel.scores[state.currentMonth];
  const litSum = dayScores.reduce((sum, s) => sum + s / 100, 0);
  const shadowedHours = dayScores.filter((s) => s < 50).length * 2;

  const dailySunlightPercent = Math.round((100 * litSum) / dayScores.length);
  const sunlitAreaM2 = panel.areaM2 * (dailySunlightPercent / 100);
  const shadedAreaM2 = panel.areaM2 - sunlitAreaM2;
  return { dailySunlightPercent, shadowedHours, sunlitAreaM2, shadedAreaM2 };
}


// ---------------------------------------------------------------------------
// Selection + Details panel
// ---------------------------------------------------------------------------
async function highlight(objectId) {
  if (state.highlightHandle) {
    state.highlightHandle.remove();
    state.highlightHandle = null;
  }
  if (objectId == null) return;
  const layerView = await state.view.whenLayerView(state.panelsLayer);
  state.highlightHandle = layerView.highlight(objectId);
}

function selectPanel(id) {
  state.selected = { kind: "panel", id };
  highlight(state.panelsById.get(id).objectId);
  refreshDetailsPanel();
}

function refreshDetailsPanel() {
  const titleEl = document.getElementById("details-title");
  const contentEl = document.getElementById("details-content");

  if (!state.selected) {
    titleEl.textContent = "Details";
    contentEl.innerHTML = '<div class="empty">Click a solar panel to inspect it.</div>';
    return;
  }

  titleEl.textContent = "Solar Panel";
  contentEl.innerHTML = renderPanelDetails(state.panelsById.get(state.selected.id));
}

function renderPanelDetails(panel) {
  const daily = dailyAggregateForPanel(panel);
  return `
    <div class="detail-row"><span>Grid ID</span><span>${panel.panelId}</span></div>
    <div class="detail-row"><span>Surface area</span><span>${panel.areaM2.toFixed(2)} m²</span></div>
    <div class="detail-row"><span>Exposure score</span><span><span class="score-badge ${scoreClass(
      panel.currentScore
    )}">${panel.currentScore}</span></span></div>
    <div class="detail-row"><span>Current sunlight %</span><span>${panel.currentScore}%</span></div>
    <div class="detail-row"><span>Daily sunlight %</span><span>${daily.dailySunlightPercent}%</span></div>
    <div class="detail-row"><span>Shadowed time</span><span>${daily.shadowedHours.toFixed(
      1
    )} hrs/day</span></div>
    <div class="detail-row"><span>Sunlit area today</span><span>${daily.sunlitAreaM2.toFixed(
      2
    )} m²</span></div>
    <div class="detail-row"><span>Shaded area today</span><span>${daily.shadedAreaM2.toFixed(
      2
    )} m²</span></div>
    ${
      panel.currentScore < 50
        ? '<div class="hint">Currently shadowed (published AGOL exposure score).</div>'
        : '<div class="hint">Currently in direct sunlight.</div>'
    }
  `;
}

// ---------------------------------------------------------------------------
// Layer list UI
// ---------------------------------------------------------------------------
function setupLayerToggles(entries) {
  const container = document.getElementById("layer-rows");
  for (const { layer, onToggle, label, defaultOn } of entries) {
    if (layer) layer.visible = defaultOn;
    else onToggle?.(defaultOn);
    const row = document.createElement("div");
    row.className = "layer-row";
    const id = `layer-${Math.random().toString(36).slice(2, 8)}`;
    row.innerHTML = `<input type="checkbox" id="${id}" ${defaultOn ? "checked" : ""}/><label for="${id}">${label}</label>`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (layer) layer.visible = e.target.checked;
      else onToggle?.(e.target.checked);
    });
    container.appendChild(row);
  }
}

main().catch((err) => {
  console.error(err);
  document.getElementById("loading-overlay").innerHTML =
    '<div style="color:#d9534f">Failed to load campus data. See console for details.</div>';
});
