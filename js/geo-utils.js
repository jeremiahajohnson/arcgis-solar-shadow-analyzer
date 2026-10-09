/** Shared small geometry helpers for the campus-wide solar tessellation (3-vertex triangle
 * rings, [lon, lat, z], with a closing 4th vertex duplicating the first). Used by both the
 * 3D viewer (js/app.js) and the 2D heatmap page (js/heatmap.js). */

/** Centroid (lon, lat) of a ring's unique vertices (ignores a closing duplicate and any Z). */
export function ringCentroid(ring) {
  let sx = 0,
    sy = 0,
    n = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
    n++;
  }
  return [sx / n, sy / n];
}

/** Local equirectangular-meters area (m²) of a small (sub-meter) 3D triangle ring. */
export function triangleAreaM2(ring) {
  const [p0, p1, p2] = ring; // first 3 coords are the unique vertices; 4th closes the loop
  const latR = p0[1] * (Math.PI / 180);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(latR);
  const toLocal = (p) => [(p[0] - p0[0]) * mPerDegLon, (p[1] - p0[1]) * mPerDegLat, p[2] - p0[2]];
  const v1 = toLocal(p1);
  const v2 = toLocal(p2);
  const cross = [
    v1[1] * v2[2] - v1[2] * v2[1],
    v1[2] * v2[0] - v1[0] * v2[2],
    v1[0] * v2[1] - v1[1] * v2[0],
  ];
  return 0.5 * Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
}
