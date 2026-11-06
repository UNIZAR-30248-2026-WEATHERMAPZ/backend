const defaultRepository = require('../../repositories/dataStatusRepository');
const { getVegetationStatus } = require('../vegetation/vegetationService');

const ASSOCIATION_TYPES = ['tree', 'building'];

async function getDataStatus({
  repository = defaultRepository,
  vegetationStatus = getVegetationStatus
} = {}) {
  const [imports, associations, vegetation] = await Promise.all([
    repository.getLatestImportRuns(),
    repository.getLatestAssociationRuns(ASSOCIATION_TYPES),
    vegetationStatus()
  ]);
  return {
    imports,
    associations: associations.map((run) => ({ ...run, stale: run.status === 'stale' })),
    vegetation
  };
}

module.exports = { getDataStatus };
