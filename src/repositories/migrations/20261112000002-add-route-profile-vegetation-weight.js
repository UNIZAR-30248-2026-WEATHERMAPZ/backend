// Vegetation weight of the saved routes (PBI-10 phase B, ADR-031). 0 by default, so existing
// routes, presets included, keep choosing exactly as before. There is no "green" preset (ADR-026).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE route_profiles
        ADD COLUMN vegetation_weight SMALLINT NOT NULL DEFAULT 0
          CHECK (vegetation_weight BETWEEN 0 AND 100);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE route_profiles DROP COLUMN IF EXISTS vegetation_weight;'
    );
  }
};
