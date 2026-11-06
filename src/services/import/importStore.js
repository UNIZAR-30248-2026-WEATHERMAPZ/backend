const associationRepository = require('../../repositories/associationRepository');
const importRepository = require('../../repositories/importRepository');
const urbanElementRepository = require('../../repositories/urbanElementRepository');

// Association types whose results an import of each table can invalidate (ADR-010). Green
// areas have no association; the vegetation index checks their import itself (ADR-026).
const AFFECTED_ASSOCIATIONS = {
  buildings: ['building'],
  trees: ['tree'],
  street_segments: ['tree', 'building']
};

function createImportStore(table, source) {
  const affected = AFFECTED_ASSOCIATIONS[table];
  return {
    ...(affected && {
      markAssociationsStale: (runId) =>
        associationRepository.markStale(affected, `import ${table} run ${runId}`)
    }),
    createRun: importRepository.createRun,
    finishRun: importRepository.finishRun,
    insertRejections: importRepository.insertRejections,
    upsertBatch: (records, runId) =>
      urbanElementRepository.upsertBatch(table, records, { source, runId }),
    deleteStale: (runId) => urbanElementRepository.deleteStale(table, { source, runId })
  };
}

module.exports = { createImportStore };
