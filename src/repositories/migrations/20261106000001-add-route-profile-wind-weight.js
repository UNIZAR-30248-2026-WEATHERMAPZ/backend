// Wind weight of the saved routes (PBI-8.2, ADR-025). 0 by default, so existing routes, presets
// included, keep choosing exactly as before.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE route_profiles
        ADD COLUMN wind_weight SMALLINT NOT NULL DEFAULT 0
          CHECK (wind_weight BETWEEN 0 AND 100);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE route_profiles DROP COLUMN IF EXISTS wind_weight;'
    );
  }
};
