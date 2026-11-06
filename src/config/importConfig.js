function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) ? value : fallback;
}

const importConfig = {
  idezarWfsUrl:
    process.env.IDEZAR_WFS_URL || 'https://idezar-sig.zaragoza.es/servicios/geoserver/wfs',
  overpassUrl: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
  wfsPageSize: numberFromEnv('IMPORT_WFS_PAGE_SIZE', 2000),
  batchSize: numberFromEnv('IMPORT_BATCH_SIZE', 500),
  datasets: {
    buildings: { source: 'idezar', typeName: 'citygml3d:building', sortBy: 'identifier' },
    trees: { source: 'idezar', typeName: 'idezar_base:arboles_2022', sortBy: 'ID' },
    streets: { source: 'osm', municipalityIneRef: '50297' },
    // Parks and gardens for the vegetation index (PBI-10, ADR-026).
    greenAreas: { source: 'osm', municipalityIneRef: '50297' }
  },
  // Extent published by IDEZAR for the municipality of Zaragoza (catalogue spatialCoverage).
  zaragozaBbox: {
    minLng: -1.1862019211502268,
    minLat: 41.45179233764389,
    maxLng: -0.6849645835987654,
    maxLat: 41.81025542204428
  },
  // Building height rule; every threshold is explained in ADR-001 (workspace docs/DECISIONS.md).
  height: {
    // Estimate used when the measured height is wrong: storeys × floorHeightM + groundFloorExtraM.
    floorHeightM: numberFromEnv('BUILDING_FLOOR_HEIGHT_M', 3),
    groundFloorExtraM: numberFromEnv('BUILDING_GROUND_FLOOR_EXTRA_M', 1),
    // Used only when there is neither a usable measured height nor a storey count.
    defaultHeightM: numberFromEnv('BUILDING_DEFAULT_HEIGHT_M', 4),
    // A measured height outside [min, max] is wrong for any building.
    minHeightM: numberFromEnv('BUILDING_MIN_HEIGHT_M', 2),
    maxHeightM: numberFromEnv('BUILDING_MAX_HEIGHT_M', 150),
    // Buildings with 2+ storeys: height per storey outside [min, max] is wrong.
    minHeightPerFloorM: numberFromEnv('BUILDING_MIN_HEIGHT_PER_FLOOR_M', 2),
    maxHeightPerFloorM: numberFromEnv('BUILDING_MAX_HEIGHT_PER_FLOOR_M', 8),
    // Buildings with 1 storey (or unknown): accepted up to this height.
    maxSingleStoreyHeightM: numberFromEnv('BUILDING_MAX_SINGLE_STOREY_HEIGHT_M', 40),
    // Accepted heights above these values are kept but flagged as height_suspicious.
    suspiciousSingleStoreyHeightM: numberFromEnv('BUILDING_SUSPICIOUS_SINGLE_STOREY_HEIGHT_M', 15),
    suspiciousHeightPerFloorM: numberFromEnv('BUILDING_SUSPICIOUS_HEIGHT_PER_FLOOR_M', 6)
  }
};

module.exports = { importConfig, numberFromEnv };
