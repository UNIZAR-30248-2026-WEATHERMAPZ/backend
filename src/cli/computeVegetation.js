const { sequelize } = require('../config/database');
const { runVegetation } = require('../services/vegetation/vegetationService');
const { logger } = require('../utils/logger');

const round = (value, decimals = 1) =>
  value === null || value === undefined ? '-' : Number(value).toFixed(decimals);
const share = (part, total) => (total > 0 ? (100 * part) / total : null);

function table(rows) {
  const columns = Object.keys(rows[0] ?? {});
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column]).length))
  );
  const line = (values) => values.map((value, i) => String(value).padStart(widths[i])).join('  ');
  return [line(columns), ...rows.map((row) => line(columns.map((column) => row[column])))].join(
    '\n'
  );
}

function formatSummary(summary) {
  const totals = table([
    {
      status: summary.status,
      segments: summary.segments,
      street_segments: summary.streetSegments,
      km: round(summary.lengthM / 1000),
      'green_%': round(summary.greenPercentage),
      'trees_%': round(share(summary.treeLengthM, summary.lengthM)),
      'green_areas_%': round(share(summary.greenAreaLengthM, summary.lengthM)),
      seconds: round(summary.durationMs / 1000)
    }
  ]);
  const distribution = table(
    summary.distribution.map((bucket) => ({
      'green_ratio_%': bucket.range,
      segments: bucket.segments,
      'length_%': round(bucket.lengthPercentage)
    }))
  );
  return `${totals}\n\n${distribution}`;
}

// Returns the exit code: 0 only if the run is 'success' (one row per street segment).
async function runComputeVegetationCli({
  run = runVegetation,
  write = (text) => process.stdout.write(text)
} = {}) {
  try {
    const summary = await run();
    write(`${formatSummary(summary)}\n`);
    if (summary.status !== 'success') {
      logger.error(
        `[vegetation] ${summary.status.toUpperCase()} run=${summary.runId}` +
          ` segments=${summary.segments} street_segments=${summary.streetSegments}`
      );
      return 1;
    }
    return 0;
  } catch (error) {
    logger.error(`Vegetation index failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  runComputeVegetationCli().then(async (exitCode) => {
    await sequelize.close();
    process.exitCode = exitCode;
  });
}

module.exports = { formatSummary, runComputeVegetationCli };
