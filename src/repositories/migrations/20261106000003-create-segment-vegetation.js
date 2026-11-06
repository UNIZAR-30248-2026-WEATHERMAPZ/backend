// Vegetation index of each street segment (PBI-10, ADR-026), rebuilt by "npm run compute:vegetation".
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      -- One row per execution. The ids of the tree association and of the green areas import it
      -- used tell whether the index still matches the data.
      CREATE TABLE vegetation_runs (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        params JSONB NOT NULL,
        tree_association_run_id INTEGER REFERENCES association_runs (id) ON DELETE SET NULL,
        green_areas_import_run_id INTEGER REFERENCES import_runs (id) ON DELETE SET NULL,
        segments INTEGER,
        street_segments INTEGER,
        length_m DOUBLE PRECISION,
        green_length_m DOUBLE PRECISION,
        status VARCHAR(20) NOT NULL DEFAULT 'running'
          CHECK (status IN ('running', 'success', 'mismatch', 'failed')),
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX vegetation_runs_started_idx ON vegetation_runs (started_at DESC);

      -- Lengths in metres measured in EPSG:25830. green_length_m is the union of the tree and the
      -- green area parts, so a stretch near a tree inside a park counts once.
      CREATE TABLE segment_vegetation (
        segment_id INTEGER PRIMARY KEY REFERENCES street_segments (id) ON DELETE CASCADE,
        length_m DOUBLE PRECISION NOT NULL CHECK (length_m >= 0),
        tree_length_m DOUBLE PRECISION NOT NULL CHECK (tree_length_m >= 0),
        green_area_length_m DOUBLE PRECISION NOT NULL CHECK (green_area_length_m >= 0),
        green_length_m DOUBLE PRECISION NOT NULL CHECK (green_length_m >= 0),
        green_ratio DOUBLE PRECISION NOT NULL CHECK (green_ratio BETWEEN 0 AND 1),
        trees_count INTEGER NOT NULL CHECK (trees_count >= 0),
        vegetation_run_id INTEGER REFERENCES vegetation_runs (id) ON DELETE SET NULL
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS segment_vegetation;
      DROP TABLE IF EXISTS vegetation_runs;
    `);
  }
};
