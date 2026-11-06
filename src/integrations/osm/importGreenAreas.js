const { importConfig } = require('../../config/importConfig');
const { createImportStore } = require('../../services/import/importStore');
const { runImport } = require('../../services/import/importRunner');
const { runImportsCli } = require('../cli');
const { buildGreenAreasQuery, mapGreenArea } = require('./greenAreas');
const { runOverpassQuery } = require('./overpassClient');

// Overpass answers in one response; its element count is the source count for the run.
async function* fetchGreenAreas(config, query) {
  const elements = await runOverpassQuery(config.overpassUrl, query);
  yield { sourceCount: elements.length, items: elements };
}

function importGreenAreas({ config = importConfig, store } = {}) {
  const { source, municipalityIneRef } = config.datasets.greenAreas;
  const query = buildGreenAreasQuery(municipalityIneRef);
  return runImport({
    dataset: 'green_areas',
    sourceUrl: `${config.overpassUrl}?data=${encodeURIComponent(query)}`,
    pages: fetchGreenAreas(config, query),
    mapItem: (element) => ({
      ...mapGreenArea(element, { bbox: config.zaragozaBbox }),
      raw: element
    }),
    store: store || createImportStore('green_areas', source),
    batchSize: config.batchSize
  });
}

if (require.main === module) runImportsCli([importGreenAreas]);

module.exports = { importGreenAreas };
