const request = require('supertest');

const { createApp } = require('../../app');
const { associationConfig } = require('../../config/associationConfig');
const { sequelize } = require('../../config/database');
const { env } = require('../../config/env');
const { vegetationConfig } = require('../../config/vegetationConfig');
const { markStale } = require('../../repositories/associationRepository');
const { createRun, finishRun } = require('../../repositories/importRepository');
const {
  findGreenRatios,
  withStatementTimeout
} = require('../../repositories/vegetationRepository');
const { signToken } = require('../../services/auth/tokenService');
const { runAssociation } = require('../../services/geo/associationService');
const {
  getVegetationStatus,
  runVegetation
} = require('../../services/vegetation/vegetationService');

/*
 * Synthetic dataset in EPSG:25830 (metres) relative to (X0, Y0), stored in 4326 like the real
 * data. A tree at distance d from a segment covers 2·√(8² − d²) m of it; the 0.3 m tolerance
 * covers the polygonal discs of ST_Buffer and the geography distances of segment_trees.
 *
 *   y=100  S_PARK ──────────────────── park x 50..150 (100 m), T_PARK 4 m inside the park
 *   y=0    S_TREES ─────────────────── T_5M 5 m (12.49 m), T_END 3 m before x=0 (5 m), T_12M 12 m
 *   y=-200 S_NONE ──────────────────── nothing
 */
const X0 = 675000;
const Y0 = 4613000;
const TOLERANCE_M = 0.3;
const covered = (distance) => 2 * Math.sqrt(8 ** 2 - distance ** 2);

const segments = {
  S_TREES: [
    [0, 0],
    [200, 0]
  ],
  S_PARK: [
    [0, 100],
    [200, 100]
  ],
  S_NONE: [
    [0, -200],
    [200, -200]
  ]
};

// [x, y]
const trees = {
  T_5M: [100, 5],
  // 3 m from the start of S_TREES along its axis: its disc covers x 0..5.
  T_END: [-3, 0],
  // Linked by the 25 m association radius but outside the 8 m of the index.
  T_12M: [160, 12],
  T_PARK: [140, 104]
};

const xy = ([x, y]) => `${X0 + x} ${Y0 + y}`;
const toWgs84 = (wkt) => `ST_Transform(ST_GeomFromText('${wkt}', 25830), 4326)`;
const rows = (sql, replacements) =>
  sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

async function importGreenAreasRun(status = 'success') {
  const runId = await createRun({ dataset: 'green_areas', sourceUrl: 'https://overpass.test' });
  await finishRun(runId, {
    sourceCount: 1,
    importedCount: 1,
    rejectedCount: 0,
    status,
    details: {}
  });
  return runId;
}

async function loadDataset() {
  for (const [name, line] of Object.entries(segments)) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `INSERT INTO street_segments (source, source_id, osm_way_id, highway, geom, length_m)
       VALUES ('synthetic', :name, 1, 'footway', ${toWgs84(`LINESTRING(${line.map(xy).join(', ')})`)}, 200)`,
      { replacements: { name } }
    );
  }
  for (const [name, point] of Object.entries(trees)) {
    // eslint-disable-next-line no-await-in-loop
    await sequelize.query(
      `INSERT INTO trees (source, source_id, geom)
       VALUES ('synthetic', :name, ${toWgs84(`POINT(${xy(point)})`)})`,
      { replacements: { name } }
    );
  }
  const park = [
    [50, 80],
    [150, 80],
    [150, 120],
    [50, 120],
    [50, 80]
  ];
  await sequelize.query(
    `INSERT INTO green_areas (source, source_id, kind, name, geom)
     VALUES ('osm', 'way/1', 'park', 'Parque', ${toWgs84(`MULTIPOLYGON(((${park.map(xy).join(', ')})))`)})`
  );
}

const vegetationOf = async () =>
  Object.fromEntries(
    (
      await rows(`
        SELECT s.source_id, v.length_m, v.tree_length_m, v.green_area_length_m, v.green_length_m,
          v.green_ratio, v.trees_count
        FROM segment_vegetation v JOIN street_segments s ON s.id = v.segment_id`)
    ).map(({ source_id: name, ...values }) => [name, values])
  );

describe('vegetation index of the street segments (PostGIS)', () => {
  const originalSecret = env.jwtSecret;

  beforeAll(() => {
    env.jwtSecret = 'test-secret';
  });

  beforeEach(async () => {
    await sequelize.query(
      `TRUNCATE trees, buildings, street_segments, association_runs, unassociated_elements,
         import_rejections, import_runs, green_areas, vegetation_runs RESTART IDENTITY CASCADE`
    );
    await loadDataset();
    await runAssociation({ config: associationConfig });
    await importGreenAreasRun();
  });

  afterAll(async () => {
    env.jwtSecret = originalSecret;
    await sequelize.close();
  });

  it('measures the length near trees and inside green areas of every segment', async () => {
    const summary = await runVegetation();

    expect(summary).toMatchObject({ status: 'success', segments: 3, streetSegments: 3 });
    const vegetation = await vegetationOf();

    const lined = vegetation.S_TREES;
    expect(lined.length_m).toBeCloseTo(200, 0);
    expect(Math.abs(lined.tree_length_m - (covered(5) + 5))).toBeLessThan(TOLERANCE_M);
    expect(lined.green_area_length_m).toBe(0);
    expect(lined.green_length_m).toBeCloseTo(lined.tree_length_m, 6);
    expect(lined.green_ratio).toBeCloseTo(lined.green_length_m / lined.length_m, 6);
    // T_12M is linked to the segment by the association but is farther than 8 m.
    expect(lined.trees_count).toBe(2);

    // The tree inside the park does not add length: the union counts it once.
    const park = vegetation.S_PARK;
    expect(Math.abs(park.tree_length_m - covered(4))).toBeLessThan(TOLERANCE_M);
    expect(Math.abs(park.green_area_length_m - 100)).toBeLessThan(TOLERANCE_M);
    expect(Math.abs(park.green_length_m - 100)).toBeLessThan(TOLERANCE_M);
    expect(park.trees_count).toBe(1);

    expect(vegetation.S_NONE).toMatchObject({
      tree_length_m: 0,
      green_area_length_m: 0,
      green_length_m: 0,
      green_ratio: 0,
      trees_count: 0
    });

    const [run] = await rows('SELECT * FROM vegetation_runs');
    expect(run).toMatchObject({
      status: 'success',
      segments: 3,
      street_segments: 3,
      tree_association_run_id: expect.any(Number),
      green_areas_import_run_id: 1,
      params: { treeRadiusM: 8, batchSize: 5000, batchTimeoutMs: 60000 }
    });
    expect(run.details.distribution.map(({ range }) => range)).toEqual(['0', '0-20', '40-60']);
  });

  it('gives the green ratio of the segments of a route (PBI-10 phase B)', async () => {
    await runVegetation();
    const streetSegments = await rows('SELECT id, source_id FROM street_segments ORDER BY id');
    const vegetation = await vegetationOf();

    const ratios = await findGreenRatios([...streetSegments.map(({ id }) => id), 999999]);

    // One entry per segment with an index; an unknown segment is simply missing.
    expect(ratios.size).toBe(3);
    expect(ratios.has(999999)).toBe(false);
    streetSegments.forEach(({ id, source_id: sourceId }) => {
      expect(ratios.get(id)).toBeCloseTo(vegetation[sourceId].green_ratio, 6);
    });
    expect(ratios.get(streetSegments.find(({ source_id: name }) => name === 'S_NONE').id)).toBe(0);
    expect(await findGreenRatios([])).toEqual(new Map());
  });

  it('gives the same index when repeated, also in batches of one segment', async () => {
    await runVegetation();
    const first = await vegetationOf();

    await runVegetation({ config: { ...vegetationConfig, batchSize: 1 } });

    const second = await vegetationOf();
    expect(Object.keys(second)).toEqual(Object.keys(first));
    Object.entries(first).forEach(([name, values]) =>
      Object.entries(values).forEach(([key, value]) =>
        expect([name, key, second[name][key]]).toEqual([name, key, expect.closeTo(value, 6)])
      )
    );
  });

  it('applies the batch timeout to every statement of the transaction', async () => {
    const [{ statement_timeout: timeout }] = await withStatementTimeout(1234, (transaction) =>
      sequelize.query('SHOW statement_timeout', {
        type: sequelize.QueryTypes.SELECT,
        transaction
      })
    );

    expect(timeout).toBe('1234ms');
    expect(() => withStatementTimeout(0, jest.fn())).toThrow(
      'timeoutMs must be a positive integer'
    );
  });

  it('refuses to run on a stale tree association or without a green areas import', async () => {
    await markStale(['tree'], 'test');
    await expect(runVegetation()).rejects.toThrow('tree association is stale');

    await sequelize.query('TRUNCATE import_runs RESTART IDENTITY CASCADE');
    await expect(runVegetation()).rejects.toThrow('green areas import is missing');
    expect(await rows('SELECT id FROM vegetation_runs')).toEqual([]);
  });

  it('becomes stale after a new association or green areas import, until it is recalculated', async () => {
    expect(await getVegetationStatus()).toBeNull();
    await runVegetation();
    expect(await getVegetationStatus()).toMatchObject({
      status: 'success',
      segments: 3,
      treeRadiusM: 8,
      stale: false,
      staleReasons: []
    });

    await runAssociation({ config: associationConfig, types: ['tree'] });
    await importGreenAreasRun();
    expect((await getVegetationStatus()).staleReasons).toEqual([
      'tree_association_changed',
      'green_areas_import_changed'
    ]);

    await runVegetation();
    await markStale(['tree'], 'import trees run 99');
    expect((await getVegetationStatus()).staleReasons).toEqual(['tree_association_stale']);
  });

  it('shows the index in GET /api/data/status', async () => {
    await runVegetation();
    const auth = { Authorization: `Bearer ${signToken({ id: 1 })}` };

    const response = await request(createApp()).get('/api/data/status').set(auth);

    expect(response.status).toBe(200);
    expect(response.body.imports.map(({ dataset }) => dataset)).toEqual(['green_areas']);
    expect(response.body.vegetation).toMatchObject({
      status: 'success',
      segments: 3,
      streetSegments: 3,
      stale: false
    });
    // (12.49 + 5 + 100) m green out of 600 m.
    expect(response.body.vegetation.greenPercentage).toBeCloseTo((covered(5) + 5 + 100) / 6, 0);
  });
});
