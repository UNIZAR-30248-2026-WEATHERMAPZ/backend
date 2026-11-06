const { importConfig } = require('../../config/importConfig');
const { buildGreenAreasQuery, mapGreenArea } = require('../../integrations/osm/greenAreas');
const { importGreenAreas } = require('../../integrations/osm/importGreenAreas');
const { createImportStore } = require('../../services/import/importStore');
const overpass = require('../fixtures/overpass-green-areas.json');

const bbox = importConfig.zaragozaBbox;
const byId = (type, id) => overpass.elements.find((e) => e.type === type && e.id === id);
const square = [
  { lat: 41.65, lon: -0.89 },
  { lat: 41.65, lon: -0.888 },
  { lat: 41.652, lon: -0.888 },
  { lat: 41.65, lon: -0.89 }
];

const response = (body) => ({ ok: true, status: 200, json: async () => body });

function memoryStore() {
  const store = {
    records: [],
    rejections: [],
    createRun: jest.fn().mockResolvedValue(1),
    finishRun: jest.fn().mockResolvedValue(),
    insertRejections: jest.fn(async (_runId, _dataset, rows) => store.rejections.push(...rows)),
    upsertBatch: jest.fn(async (records) => {
      store.records.push(...records);
      return { failures: [], repaired: 0 };
    }),
    deleteStale: jest.fn().mockResolvedValue(0)
  };
  return store;
}

describe('buildGreenAreasQuery', () => {
  it('asks for public parks and gardens, ways and multipolygons, with their geometry', () => {
    const query = buildGreenAreasQuery('50297');

    expect(query).toContain('["ref:ine"~"^50297"]');
    expect(query).toContain('way["leisure"~"^(park|garden)$"]["access"!~"^(private|no)$"]');
    expect(query).toContain('relation["leisure"~"^(park|garden)$"]');
    expect(query).toContain('["type"="multipolygon"]');
    expect(query).toContain('out geom;');
  });
});

describe('mapGreenArea', () => {
  it('maps a closed way to one ring with its kind and name', () => {
    const result = mapGreenArea(byId('way', 200), { bbox });

    expect(result.sourceId).toBe('way/200');
    expect(result.records).toEqual([
      {
        itemId: 'way/200',
        sourceId: 'way/200',
        kind: 'park',
        name: 'Parque A',
        geometry: {
          type: 'MultiLineString',
          coordinates: [expect.arrayContaining([[-0.89, 41.65]])]
        }
      }
    ]);
    expect(result.records[0].geometry.coordinates[0]).toHaveLength(5);
    expect(result.stats).toEqual({ park: 1 });
  });

  it('maps a multipolygon to the rings of its member ways, ignoring other members', () => {
    const result = mapGreenArea(byId('relation', 300), { bbox });

    expect(result.sourceId).toBe('relation/300');
    expect(result.records[0]).toMatchObject({ kind: 'garden', name: null });
    expect(result.records[0].geometry.coordinates).toHaveLength(2);
  });

  it.each([
    [{ type: 'way', id: 1, tags: { leisure: 'playground' }, geometry: square }, 'not_green_area'],
    [
      { type: 'way', id: 1, tags: { leisure: 'park', access: 'no' }, geometry: square },
      'not_public'
    ],
    [byId('way', 201), 'not_public'],
    [{ type: 'node', id: 1, tags: { leisure: 'park' } }, 'unsupported_element'],
    [byId('way', 202), 'open_way'],
    [byId('way', 203), 'outside_zaragoza_bbox'],
    [byId('relation', 304), 'missing_geometry'],
    [{ type: 'way', id: 1, tags: { leisure: 'park' } }, 'missing_geometry']
  ])('rejects %j as %s', (element, reason) => {
    expect(mapGreenArea(element, { bbox }).rejection).toBe(reason);
  });

  it('ignores points without coordinates', () => {
    const element = {
      type: 'way',
      id: 9,
      tags: { leisure: 'park' },
      geometry: [...square.slice(0, 2), null, { lat: 41.7 }, ...square.slice(2)]
    };

    expect(mapGreenArea(element, { bbox }).records[0].geometry.coordinates[0]).toHaveLength(4);
  });
});

describe('importGreenAreas', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('imports the fixture and reconciles the element count', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(overpass));
    const store = memoryStore();

    const summary = await importGreenAreas({ store });

    expect(summary).toMatchObject({ status: 'success', sourceCount: 6, imported: 2, rejected: 4 });
    expect(summary.details.stats).toEqual({ park: 1, garden: 1 });
    expect(store.records.map((record) => record.sourceId)).toEqual(['way/200', 'relation/300']);
    expect(store.rejections.map((row) => [row.sourceId, row.reason])).toEqual([
      ['way/201', 'not_public'],
      ['way/202', 'open_way'],
      ['way/203', 'outside_zaragoza_bbox'],
      ['relation/304', 'missing_geometry']
    ]);
    expect(store.createRun).toHaveBeenCalledWith({
      dataset: 'green_areas',
      sourceUrl: expect.stringContaining('leisure')
    });
    expect(new URLSearchParams(global.fetch.mock.calls[0][1].body).get('data')).toContain(
      'out geom;'
    );
  });

  it('does not mark the street associations as stale', () => {
    expect(createImportStore('green_areas', 'osm').markAssociationsStale).toBeUndefined();
    expect(createImportStore('trees', 'idezar').markAssociationsStale).toEqual(
      expect.any(Function)
    );
  });
});
