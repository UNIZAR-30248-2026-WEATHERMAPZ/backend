const { numberFromEnv } = require('./importConfig');

// Vegetation index of the street segments; every value is explained in ADR-026 (workspace
// docs/DECISIONS.md).
const vegetationConfig = {
  // A stretch of a segment counts as tree-lined when a tree is at most this far.
  treeRadiusM: numberFromEnv('VEGETATION_TREE_RADIUS_M', 8),
  // Segments per INSERT ... SELECT, by id range, inside the transaction of the run.
  batchSize: numberFromEnv('VEGETATION_BATCH_SIZE', 5000),
  // PostgreSQL statement_timeout of each batch, so one batch cannot keep the database busy.
  batchTimeoutMs: numberFromEnv('VEGETATION_BATCH_TIMEOUT_MS', 60000)
};

module.exports = { vegetationConfig };
