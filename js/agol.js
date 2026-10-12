/** Shared ArcGIS Online hosted-feature-layer query helper, used by the 2D heatmap page
 * (js/heatmap.js) to page through FEATURE_SERVICES.solarPanelsAnnual. (js/app.js has its
 * own copy of this same pagination pattern for the same service -- kept separate per-page
 * rather than shared, since app.js is left untouched.) */

/** Pages through a hosted feature layer's query endpoint (maxRecordCount-limited) to fetch
 * every feature's geometry + the given outFields. Uses the ArcGIS Maps SDK's own request
 * layer so an already-configured esriConfig.apiKey is applied automatically. */
export async function queryAllFeatures(serviceUrl, outFields) {
  const [FeatureLayer] = await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js"]);
  const layer = new FeatureLayer({ url: serviceUrl });
  await layer.load();
  const pageSize = layer.capabilities?.query?.maxRecordCount || 2000;

  const all = [];
  let start = 0;
  for (;;) {
    const result = await layer.queryFeatures({
      where: "1=1",
      outFields,
      returnGeometry: true,
      returnZ: true,
      // The hosted service's native spatial reference is Web Mercator -- without this,
      // queryFeatures() returns rings in meters, which callers would then misinterpret as
      // WGS84 lon/lat degrees (placing every panel off in nowhere).
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
