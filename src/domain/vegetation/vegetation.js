/*
 * Rules of the vegetation index of the street segments (ADR-026). The index measures presence of
 * green (trees and public green areas), not shade: the shade of the tree crowns is PBI-5.
 */

/*
 * The trees near a segment are read from segment_trees, so the radius of the index cannot be
 * larger than the radius used by the tree association (ASSOC_TREE_RADIUS_M).
 */
function validateVegetationConfig(config, associationTreeRadiusM) {
  const problems = [];
  if (!Number.isFinite(config.treeRadiusM) || config.treeRadiusM <= 0) {
    problems.push('treeRadiusM must be > 0');
  } else if (
    Number.isFinite(associationTreeRadiusM) &&
    config.treeRadiusM > associationTreeRadiusM
  ) {
    problems.push(
      `treeRadiusM (${config.treeRadiusM}) must not exceed the tree association radius (${associationTreeRadiusM})`
    );
  }
  ['batchSize', 'batchTimeoutMs'].forEach((key) => {
    if (!Number.isInteger(config[key]) || config[key] < 1) {
      problems.push(`${key} must be an integer >= 1`);
    }
  });
  if (problems.length > 0) throw new Error(`Invalid vegetation config: ${problems.join('; ')}`);
  return config;
}

/*
 * The index can only be calculated from a successful tree association that is not stale and a
 * successful green areas import. Returns the reasons it cannot, or an empty list.
 */
function missingPrerequisites({ treeAssociation, greenAreasImport }) {
  const missing = [];
  if (treeAssociation?.status !== 'success') {
    missing.push(
      `tree association is ${treeAssociation?.status ?? 'missing'}; run "npm run associate"`
    );
  }
  if (greenAreasImport?.status !== 'success') {
    missing.push(
      `green areas import is ${greenAreasImport?.status ?? 'missing'}; run "npm run import:green-areas"`
    );
  }
  return missing;
}

// Every street segment must have exactly one row (the table CHECK keeps ratios within [0, 1]).
function evaluateVegetation(counts) {
  const reconciled = counts.segments === counts.streetSegments;
  const greenPercentage = counts.lengthM > 0 ? (100 * counts.greenLengthM) / counts.lengthM : 0;
  return { reconciled, greenPercentage, status: reconciled ? 'success' : 'mismatch' };
}

/*
 * The index is stale when it was calculated from a tree association or a green areas import that
 * is no longer the latest finished one, or when that association has been marked stale by a
 * later import (ADR-010). Returns the reasons, empty when it is up to date.
 */
function staleReasons(run, { treeAssociation, greenAreasImport }) {
  if (!run) return [];
  const reasons = [];
  if (!treeAssociation || treeAssociation.id !== run.treeAssociationRunId) {
    reasons.push('tree_association_changed');
  } else if (treeAssociation.status === 'stale') {
    reasons.push('tree_association_stale');
  }
  if (!greenAreasImport || greenAreasImport.id !== run.greenAreasImportRunId) {
    reasons.push('green_areas_import_changed');
  }
  return reasons;
}

module.exports = {
  evaluateVegetation,
  missingPrerequisites,
  staleReasons,
  validateVegetationConfig
};
