const { vegetationConfig } = require('../../config/vegetationConfig');
const {
  evaluateVegetation,
  missingPrerequisites,
  staleReasons,
  validateVegetationConfig
} = require('../../domain/vegetation/vegetation');
const defaultRepository = require('../../repositories/vegetationRepository');
const { logger } = require('../../utils/logger');

// Ranges of green_ratio (in %) of the buckets returned by countResults.
const BUCKET_RANGES = ['0', '0-20', '20-40', '40-60', '60-80', '80-100'];

const percentage = (part, total) => (total > 0 ? (100 * part) / total : 0);

function describeDistribution(distribution, totalLengthM) {
  return distribution.map(({ bucket, segments, lengthM }) => ({
    range: BUCKET_RANGES[bucket],
    segments,
    lengthPercentage: percentage(lengthM, totalLengthM)
  }));
}

/*
 * "npm run compute:vegetation": recalculates the vegetation index of every street segment inside
 * one transaction, by id range, with a statement_timeout per batch (ADR-026). It refuses to run
 * on a tree association that is not 'success' or without a successful green areas import. The
 * result is stored in vegetation_runs whatever the outcome.
 */
async function runVegetation({ config = vegetationConfig, repository = defaultRepository } = {}) {
  const inputs = await repository.getInputs();
  validateVegetationConfig(config, inputs.treeAssociation?.treeRadiusM);
  const missing = missingPrerequisites(inputs);
  if (missing.length > 0) {
    throw new Error(`Cannot compute the vegetation index: ${missing.join('; ')}`);
  }

  const startedAt = Date.now();
  const { treeRadiusM, batchSize, batchTimeoutMs } = config;
  const runId = await repository.createRun(
    { treeRadiusM, batchSize, batchTimeoutMs },
    {
      treeAssociationRunId: inputs.treeAssociation.id,
      greenAreasImportRunId: inputs.greenAreasImport.id
    }
  );
  try {
    const { distribution, ...counts } = await repository.withStatementTimeout(
      batchTimeoutMs,
      async (transaction) => {
        await repository.clear(transaction);
        const { minId, maxId } = await repository.segmentIdRange(transaction);
        if (minId !== null && minId !== undefined) {
          for (let fromId = minId; fromId <= maxId; fromId += batchSize) {
            const range = { fromId, toId: fromId + batchSize - 1 };
            // Batches run one after another inside the same transaction.
            // eslint-disable-next-line no-await-in-loop
            await repository.computeBatch(range, config, runId, transaction);
            logger.info(`[vegetation] segments ${range.fromId}-${Math.min(range.toId, maxId)}`);
          }
        }
        return repository.countResults(transaction);
      }
    );

    const durationMs = Date.now() - startedAt;
    const summary = {
      runId,
      ...counts,
      ...evaluateVegetation(counts),
      distribution: describeDistribution(distribution, counts.lengthM),
      durationMs
    };
    await repository.finishRun(runId, {
      ...summary,
      details: {
        durationMs,
        treeLengthM: counts.treeLengthM,
        greenAreaLengthM: counts.greenAreaLengthM,
        distribution: summary.distribution
      }
    });
    return summary;
  } catch (error) {
    await repository.finishRun(runId, {
      status: 'failed',
      details: { error: error.message, durationMs: Date.now() - startedAt }
    });
    throw error;
  }
}

/*
 * Latest execution of the index for /api/data/status, or null if it has never run. stale says
 * whether it still matches the tree association and the green areas import (ADR-026).
 */
async function getVegetationStatus({ repository = defaultRepository } = {}) {
  const [run, inputs] = await Promise.all([repository.getLatestRun(), repository.getInputs()]);
  if (!run) return null;
  const reasons = staleReasons(run, inputs);
  return {
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    segments: run.segments,
    streetSegments: run.streetSegments,
    greenPercentage: run.lengthM > 0 ? percentage(run.greenLengthM, run.lengthM) : null,
    treeRadiusM: run.params?.treeRadiusM ?? null,
    stale: reasons.length > 0,
    staleReasons: reasons
  };
}

module.exports = { getVegetationStatus, runVegetation };
