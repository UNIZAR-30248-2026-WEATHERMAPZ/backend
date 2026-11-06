// Public parks and gardens of OpenStreetMap (PBI-10, ADR-026), loaded by "npm run import:green-areas".
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE green_areas (
        id SERIAL PRIMARY KEY,
        source VARCHAR(50) NOT NULL,
        source_id TEXT NOT NULL,
        kind VARCHAR(20) NOT NULL CHECK (kind IN ('park', 'garden')),
        name TEXT,
        geom geometry(MultiPolygon, 4326) NOT NULL,
        import_run_id INTEGER REFERENCES import_runs (id) ON DELETE SET NULL,
        UNIQUE (source, source_id)
      );
      CREATE INDEX green_areas_geom_gist ON green_areas USING GIST (geom);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS green_areas;');
  }
};
