/**
 * Real hosted ArcGIS Online content (org: ivt.maps.arcgis.com / "Esri Imagery Virtual Team"),
 * captured over the Esri Redlands campus, Building E. All items are public.
 */
export const CAMPUS = {
  // Building E footprint centroid; used as the reference point for solar position calcs
  // and the initial camera target.
  lat: 34.0587,
  lon: -117.1972,
  // Redlands, CA is Pacific Time; fixed to PDT (-07:00) for the July demo date.
  utcOffset: "-07:00",
};

export const PORTAL_ITEMS = {
  // Photorealistic 3D Gaussian Splat of Redlands / Building E (Spexi Redlands GS)
  gaussianSplat: "7f185e5b93cf42b79345b049e5b7bf45",
  // Integrated mesh (true 3D geometry w/ normals) -- used as an alternate, shadow-accurate
  // ground/building representation since Gaussian Splats don't support shadow-cast analysis.
  integratedMesh: "cb41846e2fa24249ba5b2a99e5033acd", // Esri_Campus_July1_2018 3D Mesh
};

export const FEATURE_SERVICES = {
  // NOTE: the old Building_E_Extracted_Solar_Panels service (642 polygons, one building)
  // has been retired from analysis -- replaced by the DSM-enriched, campus-wide solar
  // tessellation, which is now the source of truth for panel-level shadow/exposure scoring.
  trees:
    "https://services1.arcgis.com/uujCiiEZAflDbdxE/arcgis/rest/services/Esri_BuildingE_Trees/FeatureServer/0",
  buildingFootprint:
    "https://services1.arcgis.com/uujCiiEZAflDbdxE/arcgis/rest/services/Building_E_Footprint/FeatureServer/0",
  // Hosted feature layer (published from elevation/build_annual_exposure_fields.py's
  // output via publish/SolarPanelAnnualExposureScores.gdb.zip) carrying the campus-wide,
  // vegetation-spike-filtered solar tessellation plus 60 precomputed exposure-score fields
  // (12 representative days x 5 times of day -- see SNAPSHOT_HOURS/scoreFieldName below).
  // This is the live source of truth for both panel geometry and scores in the 3D viewer,
  // replacing the local data/solar_tessellation_3d.geojson + shadow_obstruction_annual.bin
  // pipeline (still used as-is by the 2D annual heatmap page, which needs finer-grained
  // per-hour data than these 5 daily snapshots provide).
  solarPanelsAnnual:
    "https://services1.arcgis.com/uujCiiEZAflDbdxE/arcgis/rest/services/SolarPanelAnnualExposureScores_v2/FeatureServer/0",
};

// The 5 discrete times of day published as score fields on the hosted solarPanelsAnnual
// service (matches FR-2's examples: 8am, 10am, noon, 2pm, 4pm). Evenly spaced by 2 hours,
// which lets the time-slider use a plain uniform step instead of snapping to a lookup table.
export const SNAPSHOT_HOURS = [8, 10, 12, 14, 16];

// The 15th of each month, 2026 -- the 12 representative days baked into the published
// S_<MM>_<HH> score fields.
export const REPRESENTATIVE_YEAR = 2026;

/** Published field name for a given 0-based month index + snapshot hour,
 * e.g. scoreFieldName(0, 8) -> "S_01_08". */
export function scoreFieldName(monthIndex, hour) {
  const mm = String(monthIndex + 1).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  return `S_${mm}_${hh}`;
}

export const IMAGE_SERVICES = {
  // Published from the Spexi drone capture (portal item 0970aa9909004b898f6844c68a6eb71d),
  // replacing the earlier 2018 true-ortho tile service. Used as the base imagery for both
  // the 3D scene and the 2D annual heatmap page.
  trueOrtho:
    "https://tiles.arcgis.com/tiles/uujCiiEZAflDbdxE/arcgis/rest/services/RedlandsCampus_Spexicapture_Orthomosaic/MapServer",
};

// We don't have real panel spec sheets (wattage, nameplate efficiency, inverter losses,
// etc.) for this campus's solar array, so any kWh/energy-production number would be an
// unverifiable guess dressed up as a measurement. Instead, every metric in this app is
// area-based: each solar tessellation triangle's true 3D surface area (a directly measured
// quantity from the DSM-enriched geometry) is split into "sunlit" vs "shaded" portions using
// the real DSM ray-cast exposure score, so e.g. "sunlit area" literally means "this many m²
// of panel surface were in direct sun," with no assumed watts/m² in the loop at all.

// Rough, rule-of-thumb monthly peak-sun-hours (Jan-Dec) for inland Southern California
// (~34°N, Redlands/San Bernardino area) -- NOT measured insolation data, just a seasonal
// weighting shape (low in winter, peak in early/mid summer) used to weight each of the 12
// representative days (by relative day length/intensity) when rolling their DSM-measured
// shading fraction up into an annual average sunlit-area figure.
export const MONTHLY_PEAK_SUN_HOURS = [3.5, 4.3, 5.3, 6.2, 6.8, 7.2, 7.2, 6.8, 6.0, 5.0, 3.8, 3.3];

// Calendar days in each month of 2026 (not a leap year) -- used to weight each of the 12
// representative days (the 15th of each month) up to an annual total.
export const DAYS_IN_MONTH_2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
