const {
  evaluateVegetation,
  missingPrerequisites,
  staleReasons,
  validateVegetationConfig
} = require('../../domain/vegetation/vegetation');

const config = { treeRadiusM: 8, batchSize: 5000, batchTimeoutMs: 60000 };

describe('validateVegetationConfig', () => {
  it('accepts the defaults with the association radius of 25 m', () => {
    expect(validateVegetationConfig(config, 25)).toBe(config);
  });

  it('accepts a radius equal to the association radius, or an unknown association radius', () => {
    expect(() => validateVegetationConfig({ ...config, treeRadiusM: 25 }, 25)).not.toThrow();
    expect(() => validateVegetationConfig(config, undefined)).not.toThrow();
  });

  it('rejects a radius larger than the association radius: those trees are not linked', () => {
    expect(() => validateVegetationConfig({ ...config, treeRadiusM: 30 }, 25)).toThrow(
      'treeRadiusM (30) must not exceed the tree association radius (25)'
    );
  });

  it('lists every invalid value', () => {
    expect(() =>
      validateVegetationConfig({ treeRadiusM: 0, batchSize: 1.5, batchTimeoutMs: 0 }, 25)
    ).toThrow(
      'treeRadiusM must be > 0; batchSize must be an integer >= 1; batchTimeoutMs must be an integer >= 1'
    );
  });
});

describe('missingPrerequisites', () => {
  const ok = { treeAssociation: { status: 'success' }, greenAreasImport: { status: 'success' } };

  it('is empty with a successful association and green areas import', () => {
    expect(missingPrerequisites(ok)).toEqual([]);
  });

  it('asks for the command that is missing', () => {
    expect(
      missingPrerequisites({ treeAssociation: { status: 'stale' }, greenAreasImport: null })
    ).toEqual([
      'tree association is stale; run "npm run associate"',
      'green areas import is missing; run "npm run import:green-areas"'
    ]);
    expect(
      missingPrerequisites({ treeAssociation: null, greenAreasImport: { status: 'mismatch' } })
    ).toEqual([
      'tree association is missing; run "npm run associate"',
      'green areas import is mismatch; run "npm run import:green-areas"'
    ]);
  });
});

describe('evaluateVegetation', () => {
  it('succeeds with one row per street segment and returns the green percentage by length', () => {
    expect(
      evaluateVegetation({ segments: 3, streetSegments: 3, lengthM: 400, greenLengthM: 100 })
    ).toEqual({ reconciled: true, greenPercentage: 25, status: 'success' });
  });

  it('is a mismatch when a segment has no row', () => {
    expect(
      evaluateVegetation({ segments: 2, streetSegments: 3, lengthM: 0, greenLengthM: 0 })
    ).toEqual({ reconciled: false, greenPercentage: 0, status: 'mismatch' });
  });
});

describe('staleReasons', () => {
  const run = { treeAssociationRunId: 4, greenAreasImportRunId: 6 };
  const inputs = { treeAssociation: { id: 4, status: 'success' }, greenAreasImport: { id: 6 } };

  it('is empty when the index was calculated from the latest data', () => {
    expect(staleReasons(run, inputs)).toEqual([]);
  });

  it('is empty when there is no run', () => {
    expect(staleReasons(null, inputs)).toEqual([]);
  });

  it('detects a new association, a stale association and a new green areas import', () => {
    expect(staleReasons(run, { ...inputs, treeAssociation: { id: 5, status: 'success' } })).toEqual(
      ['tree_association_changed']
    );
    expect(staleReasons(run, { ...inputs, treeAssociation: { id: 4, status: 'stale' } })).toEqual([
      'tree_association_stale'
    ]);
    expect(staleReasons(run, { ...inputs, greenAreasImport: { id: 7 } })).toEqual([
      'green_areas_import_changed'
    ]);
    expect(staleReasons(run, { treeAssociation: null, greenAreasImport: null })).toEqual([
      'tree_association_changed',
      'green_areas_import_changed'
    ]);
  });
});
