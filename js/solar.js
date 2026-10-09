/**
 * Solar position + geometric shadow/exposure engine.
 *
 * MVP analysis approach:
 *  - Sun azimuth/altitude are computed with a standard NOAA solar-position
 *    algorithm (public-domain astronomical formulas), given lat/lon + a
 *    timezone-aware Date. The SAME Date object drives SceneView's
 *    `view.environment.lighting.date`, so the rendered 3D shadows and the
 *    analytic scores always agree.
 *  - Each tree casts a simplified shadow "wedge": a straight shadow of length
 *    `height / tan(altitude)` projected opposite the sun's azimuth, widened
 *    by the tree's canopy radius. A panel is considered shadowed by a tree
 *    if its centroid falls inside that wedge; obstruction strength falls off
 *    with distance from the tree and with lower sun altitude (soft edges).
 *  - This is a transparent, explainable approximation suitable for a demo
 *    and operational triage -- NOT a replacement for ArcGIS's physically
 *    based Solar Radiation tools (see stretch goals in the MVP doc).
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Day of year (1-366) for a Date, in UTC terms. */
function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = date.getTime() - start;
  return Math.floor(diff / 86400000);
}

/**
 * NOAA simplified solar position algorithm.
 * @param {Date} date - absolute instant in time (any timezone, stored as UTC internally)
 * @param {number} lat - latitude in degrees
 * @param {number} lon - longitude in degrees (east positive)
 * @returns {{altitude: number, azimuth: number}} degrees. altitude: 0 = horizon, 90 = zenith.
 *   azimuth: degrees clockwise from north (0 = N, 90 = E, 180 = S, 270 = W).
 */
export function getSunPosition(date, lat, lon) {
  const n = dayOfYear(date);
  const hoursUTC =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;

  // Fractional year (radians)
  const gamma = ((2 * Math.PI) / 365) * (n - 1 + (hoursUTC - 12) / 24);

  // Equation of time (minutes) and solar declination (radians)
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // Solar time + hour angle (degrees)
  const timeOffset = eqTime + 4 * lon;
  const trueSolarTime = hoursUTC * 60 + timeOffset; // minutes
  let hourAngleDeg = trueSolarTime / 4 - 180;
  if (hourAngleDeg < -180) hourAngleDeg += 360;
  if (hourAngleDeg > 180) hourAngleDeg -= 360;
  const ha = hourAngleDeg * DEG;

  const latR = lat * DEG;
  const cosZenith =
    Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const altitude = 90 - zenith * RAD;

  let cosAz =
    (Math.sin(decl) - Math.sin(latR) * Math.cos(zenith)) /
    (Math.cos(latR) * Math.sin(zenith));
  cosAz = Math.min(1, Math.max(-1, cosAz));
  let azimuth = Math.acos(cosAz) * RAD;
  if (hourAngleDeg > 0) azimuth = 360 - azimuth;

  return { altitude, azimuth };
}

/** 0-100 Solar Exposure Score from an obstruction fraction (diffuse light keeps a floor of ~12). */
export function exposureScore(obstruction, sunAltitude) {
  if (sunAltitude <= 0.5) return 0;
  const floor = 12;
  return Math.round(Math.max(0, 100 - obstruction * (100 - floor)));
}


/** Builds a list of sample Date objects across the daylight hours of `baseDate` (same day, same tz). */
export function daylightSamples(baseDate, startHour = 6, endHour = 19, stepHours = 0.5) {
  const samples = [];
  for (let h = startHour; h <= endHour; h += stepHours) {
    samples.push({ hour: h, date: withLocalHour(baseDate, h) });
  }
  return samples;
}

/** Returns a copy of `baseDate` (which already encodes the right timezone offset) with its local hour replaced. */
function withLocalHour(baseDate, hour) {
  // baseDate was constructed as e.g. new Date("2026-07-15T14:00:00-07:00"); we rebuild the ISO
  // string with a new hour but the same date + offset, which this app always supplies via
  // buildSceneDate() below.
  const iso = baseDate.__isoBase;
  if (!iso) return baseDate;
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  const newIso = `${iso.datePart}T${String(whole).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:00${iso.offset}`;
  return new Date(newIso);
}

/** Builds a Date for `datePart` (YYYY-MM-DD) + `hour` (0-23.99) at a fixed UTC `offset` (e.g. "-07:00"). */
export function buildSceneDate(datePart, hour, offset = "-07:00") {
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  const iso = `${datePart}T${String(whole).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:00${offset}`;
  const d = new Date(iso);
  d.__isoBase = { datePart, offset };
  return d;
}
