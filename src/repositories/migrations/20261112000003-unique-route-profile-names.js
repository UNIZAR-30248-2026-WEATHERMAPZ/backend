// The names of the routes of a user are unique without case or surrounding spaces, and
// "Recomendada" is reserved for the recommended route (PBI-9.1). Before the new index, routes
// saved before are fixed: names are trimmed, a repeated name goes to the newer route as "X (2)",
// "X (3)"... (within 40 characters) and a route called "Recomendada" becomes "Recomendada (2)".
// The log says how many of each, for the deployment. Accents still count ("Rapida" is not
// "Rápida").
const { logger } = require('../../utils/logger');

const INDEX = 'route_profiles_user_name_idx';
const MAX_NAME_LENGTH = 40;
const RESERVED_KEY = 'recomendada';

// A free name "base (n)" for the user, cutting the base so that it fits in 40 characters.
function freeName(name, takenKeys) {
  const base = name.replace(/ \(\d+\)$/, '');
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${Array.from(base)
      .slice(0, MAX_NAME_LENGTH - suffix.length)
      .join('')
      .trimEnd()}${suffix}`;
    const key = candidate.toLowerCase();
    if (!takenKeys.has(key) && key !== RESERVED_KEY) return candidate;
  }
}

// New names of the routes of one user (rows ordered by id): the oldest keeps each name.
function renameUserRoutes(rows) {
  const keepers = new Set();
  const takenKeys = new Set();
  rows.forEach((row) => {
    if (row.key !== RESERVED_KEY && !takenKeys.has(row.key)) {
      keepers.add(row.id);
      takenKeys.add(row.key);
    }
  });
  return rows.map((row) => {
    if (keepers.has(row.id)) return { ...row, newName: row.trimmed, reason: null };
    const newName = freeName(row.trimmed, takenKeys);
    takenKeys.add(newName.toLowerCase());
    return { ...row, newName, reason: row.key === RESERVED_KEY ? 'reserved' : 'duplicate' };
  });
}

module.exports = {
  renameUserRoutes,

  async up(queryInterface) {
    const { sequelize } = queryInterface;
    return sequelize.transaction(async (transaction) => {
      await sequelize.query("SET LOCAL statement_timeout = '30s'", { transaction });
      const [rows] = await sequelize.query(
        `SELECT id, user_id AS "userId", name, btrim(name) AS trimmed, lower(btrim(name)) AS key
         FROM route_profiles ORDER BY user_id, id`,
        { transaction }
      );
      const byUser = new Map();
      rows.forEach((row) => byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]));
      const counts = { trimmed: 0, duplicates: 0, reserved: 0 };
      const changes = [...byUser.values()].flatMap(renameUserRoutes).filter((row) => {
        if (row.name !== row.trimmed) counts.trimmed += 1;
        if (row.reason === 'duplicate') counts.duplicates += 1;
        if (row.reason === 'reserved') counts.reserved += 1;
        return row.newName !== row.name;
      });
      for (const { id, newName } of changes) {
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(
          'UPDATE route_profiles SET name = :name, updated_at = now() WHERE id = :id',
          { replacements: { id, name: newName }, transaction }
        );
      }
      await sequelize.query(
        `DROP INDEX IF EXISTS ${INDEX};
         CREATE UNIQUE INDEX ${INDEX} ON route_profiles (user_id, lower(btrim(name)));`,
        { transaction }
      );
      logger.info(
        `unique-route-profile-names: ${counts.trimmed} name(s) trimmed, ${counts.duplicates} ` +
          `repeated name(s) renamed and ${counts.reserved} route(s) called "Recomendada" renamed`
      );
      return counts;
    });
  },

  // The renamed routes keep their new names: only the index goes back to lower(name).
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS ${INDEX};
       CREATE UNIQUE INDEX ${INDEX} ON route_profiles (user_id, lower(name));`
    );
  }
};
