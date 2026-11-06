const { sequelize } = require('../../config/database');
const { importBuildings } = require('../../integrations/idezar/importBuildings');
const { importTrees } = require('../../integrations/idezar/importTrees');
const { importGreenAreas } = require('../../integrations/osm/importGreenAreas');
const { importStreets } = require('../../integrations/osm/importStreets');
const { upsertBatch } = require('../../repositories/urbanElementRepository');
const buildings = require('../fixtures/idezar-buildings.json');
const trees = require('../fixtures/idezar-trees.json');
const greenAreas = require('../fixtures/overpass-green-areas.json');
const overpass = require('../fixtures/overpass-streets.json');

const response = (body) => ({ ok: true, status: 200, json: async () => body });
const count = async (sql) => Number((await sequelize.query(sql, { plain: true })).count);

const bowtie = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-0.9, 41.6],
        [-0.89, 41.61],
        [-0.89, 41.6],
        [-0.9, 41.61],
        [-0.9, 41.6]
      ]
    ]
  ]
};
const flat = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-0.9, 41.6],
        [-0.89, 41.6],
        [-0.88, 41.6],
        [-0.9, 41.6]
      ]
    ]
  ]
};
const building = (sourceId, geometry) => ({
  itemId: sourceId,
  sourceId,
  heightM: 10,
  heightSource: 'measured',
  heightSuspicious: false,
  floors: 3,
  geometry
});

describe('import persistence (PostGIS)', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await sequelize.query(
      'TRUNCATE buildings, trees, street_segments, green_areas, import_rejections, import_runs RESTART IDENTITY CASCADE'
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('imports buildings idempotently and records the run and rejections', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(buildings));

    const first = await importBuildings();
    const second = await importBuildings();

    expect(first).toMatchObject({ status: 'success', sourceCount: 6, imported: 4, rejected: 2 });
    expect(second).toMatchObject({ status: 'success', imported: 4 });
    expect(await count('SELECT count(*) FROM buildings')).toBe(4);
    expect(
      await count(`SELECT count(*) FROM buildings WHERE import_run_id = ${second.runId}`)
    ).toBe(4);
    expect(await count("SELECT count(*) FROM import_runs WHERE status = 'success'")).toBe(2);
    expect(await count('SELECT count(*) FROM import_rejections')).toBe(4);

    const [run] = await sequelize.query(
      `SELECT source_count, imported_count, rejected_count FROM import_runs WHERE id = ${first.runId}`,
      { type: 'SELECT' }
    );
    expect(run).toEqual({ source_count: 6, imported_count: 4, rejected_count: 2 });

    const [stored] = await sequelize.query(
      `SELECT height_m, height_source, height_suspicious, floors, GeometryType(geom) AS type,
              ST_SRID(geom) AS srid
       FROM buildings WHERE source_id = 'TEST.IMPLAUSIBLE'`,
      { type: 'SELECT' }
    );
    expect(stored).toEqual({
      height_m: 13,
      height_source: 'floors_estimate',
      height_suspicious: false,
      floors: 4,
      type: 'MULTIPOLYGON',
      srid: 4326
    });
  });

  it('removes rows that disappeared from the source after a successful run', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(trees));
    await importTrees();
    const reduced = { ...trees, numberMatched: 1, features: trees.features.slice(0, 1) };
    global.fetch = jest.fn().mockResolvedValue(response(reduced));

    const summary = await importTrees();

    expect(summary.details.staleDeleted).toBe(3);
    expect(await count('SELECT count(*) FROM trees')).toBe(1);
  });

  it('keeps existing rows when the run ends in mismatch', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(trees));
    await importTrees();
    global.fetch = jest
      .fn()
      .mockResolvedValue(response({ ...trees, numberMatched: 99, features: trees.features }));

    const summary = await importTrees();

    expect(summary.status).toBe('mismatch');
    expect(await count('SELECT count(*) FROM trees')).toBe(4);
    expect(await count("SELECT count(*) FROM import_runs WHERE status = 'mismatch'")).toBe(1);
  });

  it('stores street segments with their length in metres', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(overpass));

    await importStreets();
    await importStreets();

    expect(await count('SELECT count(*) FROM street_segments')).toBe(5);
    const [segment] = await sequelize.query(
      "SELECT osm_way_id, name, highway, round(length_m) AS length FROM street_segments WHERE source_id = '100:0'",
      { type: 'SELECT' }
    );
    // 0.001° of longitude at 41.65° N is about 83 m.
    expect(segment).toEqual({ osm_way_id: '100', name: 'Calle A', highway: 'footway', length: 83 });
  });

  it('builds green areas from their rings, with holes, idempotently', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(greenAreas));

    const summary = await importGreenAreas();
    await importGreenAreas();

    expect(summary).toMatchObject({ status: 'success', imported: 2, rejected: 4 });
    const areas = await sequelize.query(
      `SELECT source_id, kind, name, ST_NumInteriorRings(ST_GeometryN(geom, 1)) AS holes,
         round((ST_Area(geom::geography) / ST_Area(ST_ConvexHull(geom)::geography))::numeric, 2)
           AS filled
       FROM green_areas ORDER BY source_id`,
      { type: 'SELECT' }
    );
    // The garden is a 0.004° × 0.003° rectangle with a 0.001° × 0.001° hole: 1/12 is empty.
    expect(areas).toEqual([
      { source_id: 'relation/300', kind: 'garden', name: null, holes: 1, filled: '0.92' },
      { source_id: 'way/200', kind: 'park', name: 'Parque A', holes: 0, filled: '1.00' }
    ]);
    expect(await count("SELECT count(*) FROM import_runs WHERE dataset = 'green_areas'")).toBe(2);
  });

  it('rejects green area rings that do not enclose an area', async () => {
    const open = {
      itemId: 'way/1',
      sourceId: 'way/1',
      kind: 'park',
      name: null,
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [-0.9, 41.6],
            [-0.89, 41.6],
            [-0.89, 41.61]
          ]
        ]
      }
    };

    const result = await upsertBatch('green_areas', [open], { source: 'osm', runId: null });

    expect(result.failures).toEqual([{ itemId: 'way/1', reason: 'invalid_geometry' }]);
    expect(await count('SELECT count(*) FROM green_areas')).toBe(0);
  });

  it('repairs invalid polygons and reports unrepairable ones', async () => {
    const result = await upsertBatch(
      'buildings',
      [building('BOWTIE', bowtie), building('FLAT', flat)],
      { source: 'test', runId: null }
    );

    expect(result).toEqual({
      failures: [{ itemId: 'FLAT', reason: 'invalid_geometry' }],
      repaired: 1
    });
    const [stored] = await sequelize.query(
      "SELECT ST_IsValid(geom) AS valid, GeometryType(geom) AS type FROM buildings WHERE source_id = 'BOWTIE'",
      { type: 'SELECT' }
    );
    expect(stored).toEqual({ valid: true, type: 'MULTIPOLYGON' });
  });

  it('isolates records PostGIS cannot parse without losing the rest of the batch', async () => {
    const degenerate = building('DEGENERATE', { type: 'MultiPolygon', coordinates: [[[[0, 0]]]] });
    const unparsable = building('UNPARSABLE', { type: 'MultiPolygon', coordinates: 'oops' });

    const result = await upsertBatch(
      'buildings',
      [building('BOWTIE', bowtie), degenerate, unparsable],
      { source: 'test', runId: null }
    );

    expect(result.failures).toEqual([
      { itemId: 'DEGENERATE', reason: 'invalid_geometry' },
      { itemId: 'UNPARSABLE', reason: expect.stringContaining('database_error') }
    ]);
    expect(await count("SELECT count(*) FROM buildings WHERE source_id = 'BOWTIE'")).toBe(1);
  });
});
