const { formatSummary, runComputeVegetationCli } = require('../../cli/computeVegetation');
const { getDataStatus } = require('../../services/geo/dataStatusService');
const {
  getVegetationStatus,
  runVegetation
} = require('../../services/vegetation/vegetationService');

const inputs = {
  treeAssociation: { id: 4, status: 'success', treeRadiusM: 25 },
  greenAreasImport: { id: 6, status: 'success' }
};

const counts = {
  segments: 25,
  streetSegments: 25,
  lengthM: 1000,
  greenLengthM: 250,
  treeLengthM: 200,
  greenAreaLengthM: 100,
  distribution: [
    { bucket: 0, segments: 20, lengthM: 700 },
    { bucket: 5, segments: 5, lengthM: 300 }
  ]
};

function fakeRepository({
  found = inputs,
  results = counts,
  range = { minId: 1, maxId: 25 }
} = {}) {
  return {
    getInputs: jest.fn().mockResolvedValue(found),
    withStatementTimeout: jest.fn((_timeoutMs, callback) => callback('tx')),
    createRun: jest.fn().mockResolvedValue(9),
    finishRun: jest.fn().mockResolvedValue(),
    clear: jest.fn().mockResolvedValue(),
    segmentIdRange: jest.fn().mockResolvedValue(range),
    computeBatch: jest.fn().mockResolvedValue(),
    countResults: jest.fn().mockResolvedValue(results),
    getLatestRun: jest.fn()
  };
}

const config = { treeRadiusM: 8, batchSize: 10, batchTimeoutMs: 1234 };

describe('runVegetation', () => {
  it('rebuilds the index by id range inside one transaction with the batch timeout', async () => {
    const repository = fakeRepository();

    const summary = await runVegetation({ config, repository });

    expect(repository.createRun).toHaveBeenCalledWith(
      { treeRadiusM: 8, batchSize: 10, batchTimeoutMs: 1234 },
      { treeAssociationRunId: 4, greenAreasImportRunId: 6 }
    );
    expect(repository.withStatementTimeout).toHaveBeenCalledWith(1234, expect.any(Function));
    expect(repository.clear).toHaveBeenCalledWith('tx');
    expect(repository.computeBatch.mock.calls.map((call) => call[0])).toEqual([
      { fromId: 1, toId: 10 },
      { fromId: 11, toId: 20 },
      { fromId: 21, toId: 30 }
    ]);
    expect(repository.computeBatch).toHaveBeenCalledWith(expect.any(Object), config, 9, 'tx');
    expect(summary).toMatchObject({
      runId: 9,
      status: 'success',
      segments: 25,
      greenPercentage: 25,
      distribution: [
        { range: '0', segments: 20, lengthPercentage: 70 },
        { range: '80-100', segments: 5, lengthPercentage: 30 }
      ]
    });
    expect(repository.finishRun).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        status: 'success',
        details: expect.objectContaining({ treeLengthM: 200, greenAreaLengthM: 100 })
      })
    );
  });

  it('computes nothing when there are no street segments', async () => {
    const repository = fakeRepository({
      range: { minId: null, maxId: null },
      results: { ...counts, segments: 0, streetSegments: 0, lengthM: 0, distribution: [] }
    });

    const summary = await runVegetation({ config, repository });

    expect(repository.computeBatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ status: 'success', greenPercentage: 0, distribution: [] });
  });

  it('reports a mismatch when a segment has no row', async () => {
    const repository = fakeRepository({ results: { ...counts, segments: 24 } });

    expect((await runVegetation({ config, repository })).status).toBe('mismatch');
  });

  it('refuses to run without its prerequisites and creates no run', async () => {
    const repository = fakeRepository({
      found: {
        treeAssociation: { ...inputs.treeAssociation, status: 'stale' },
        greenAreasImport: null
      }
    });

    await expect(runVegetation({ config, repository })).rejects.toThrow(
      'Cannot compute the vegetation index: tree association is stale; run "npm run associate"; green areas import is missing; run "npm run import:green-areas"'
    );
    expect(repository.createRun).not.toHaveBeenCalled();
  });

  it('refuses a radius larger than the one of the tree association', async () => {
    const repository = fakeRepository();

    await expect(
      runVegetation({ config: { ...config, treeRadiusM: 30 }, repository })
    ).rejects.toThrow('must not exceed the tree association radius (25)');
  });

  it('records a failed run and rethrows when a batch fails', async () => {
    const repository = fakeRepository();
    repository.computeBatch.mockRejectedValue(new Error('canceling statement due to timeout'));

    await expect(runVegetation({ config, repository })).rejects.toThrow('canceling statement');
    expect(repository.finishRun).toHaveBeenCalledWith(9, {
      status: 'failed',
      details: { error: 'canceling statement due to timeout', durationMs: expect.any(Number) }
    });
  });
});

describe('getVegetationStatus', () => {
  const run = {
    status: 'success',
    startedAt: '2026-11-06T10:00:00Z',
    finishedAt: '2026-11-06T10:01:00Z',
    params: { treeRadiusM: 8 },
    treeAssociationRunId: 4,
    greenAreasImportRunId: 6,
    segments: 25,
    streetSegments: 25,
    lengthM: 1000,
    greenLengthM: 250
  };

  it('is null when the index has never been calculated', async () => {
    const repository = fakeRepository();
    repository.getLatestRun.mockResolvedValue(null);

    expect(await getVegetationStatus({ repository })).toBeNull();
  });

  it('returns the latest run with its green percentage and whether it is stale', async () => {
    const repository = fakeRepository({
      found: { ...inputs, treeAssociation: { id: 5, status: 'success' } }
    });
    repository.getLatestRun.mockResolvedValue(run);

    expect(await getVegetationStatus({ repository })).toEqual({
      status: 'success',
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      segments: 25,
      streetSegments: 25,
      greenPercentage: 25,
      treeRadiusM: 8,
      stale: true,
      staleReasons: ['tree_association_changed']
    });
  });

  it('has no percentage while the first run is still running', async () => {
    const repository = fakeRepository();
    repository.getLatestRun.mockResolvedValue({
      ...run,
      status: 'running',
      params: undefined,
      lengthM: null
    });

    expect(await getVegetationStatus({ repository })).toMatchObject({
      status: 'running',
      greenPercentage: null,
      treeRadiusM: null,
      stale: false
    });
  });
});

describe('getDataStatus', () => {
  it('adds the vegetation index to the imports and associations', async () => {
    const repository = {
      getLatestImportRuns: jest.fn().mockResolvedValue([{ dataset: 'green_areas' }]),
      getLatestAssociationRuns: jest.fn().mockResolvedValue([{ type: 'tree', status: 'stale' }])
    };
    const vegetation = { status: 'success', stale: true };

    expect(
      await getDataStatus({ repository, vegetationStatus: jest.fn().mockResolvedValue(vegetation) })
    ).toEqual({
      imports: [{ dataset: 'green_areas' }],
      associations: [{ type: 'tree', status: 'stale', stale: true }],
      vegetation
    });
  });
});

describe('compute:vegetation CLI', () => {
  const summary = {
    runId: 9,
    status: 'success',
    segments: 25,
    streetSegments: 25,
    greenPercentage: 25,
    distribution: [{ range: '0', segments: 20, lengthPercentage: 70 }],
    durationMs: 61300,
    ...counts
  };

  it('prints the totals and the distribution and exits with 0 on success', async () => {
    const write = jest.fn();

    const exitCode = await runComputeVegetationCli({
      run: jest.fn().mockResolvedValue({ ...summary, distribution: [] }),
      write
    });

    expect(exitCode).toBe(0);
    expect(write.mock.calls[0][0]).toContain('green_%');
  });

  it('formats the percentages of the summary', () => {
    const text = formatSummary({
      ...summary,
      distribution: [{ range: '0', segments: 20, lengthPercentage: 70 }]
    });

    expect(text).toMatch(/success\s+25\s+25\s+1\.0\s+25\.0\s+20\.0\s+10\.0\s+61\.3/);
    expect(text).toMatch(/0\s+20\s+70\.0/);
  });

  it('shows "-" for the shares of an empty network', () => {
    expect(formatSummary({ ...summary, lengthM: 0, distribution: [] })).toContain('-');
  });

  it('exits with 1 on a mismatch or an error', async () => {
    expect(
      await runComputeVegetationCli({
        run: jest.fn().mockResolvedValue({ ...summary, status: 'mismatch' }),
        write: jest.fn()
      })
    ).toBe(1);
    expect(
      await runComputeVegetationCli({
        run: jest.fn().mockRejectedValue(new Error('no association')),
        write: jest.fn()
      })
    ).toBe(1);
  });
});
