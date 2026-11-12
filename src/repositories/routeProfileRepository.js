const { UniqueConstraintError } = require('sequelize');

const { PRESET_PROFILES } = require('../domain/routes/routeWeights');
const { httpError } = require('../utils/httpError');
const { sequelize, RouteProfile, User } = require('./models');

const ATTRIBUTES = [
  'id',
  'name',
  'presetKey',
  'shadeWeight',
  'sunWeight',
  'windWeight',
  'vegetationWeight',
  'maxDetourPercentage'
];

function toProfile(row) {
  return {
    id: row.id,
    name: row.name,
    presetKey: row.presetKey,
    weights: {
      shade: row.shadeWeight,
      sun: row.sunWeight,
      wind: row.windWeight,
      vegetation: row.vegetationWeight
    },
    maxDetourPercentage: row.maxDetourPercentage
  };
}

const weightColumns = (weights) => ({
  shadeWeight: weights.shade,
  sunWeight: weights.sun,
  windWeight: weights.wind ?? 0,
  vegetationWeight: weights.vegetation ?? 0
});

/*
 * The unique index (user_id, lower(btrim(name))) decides; then the route that already has the name
 * is looked up the same way, so the 409 can say which one it is (existingId) and the frontend can
 * offer to replace it.
 */
function withDuplicateName(operation, userId, name, editedId = null) {
  return operation.catch(async (error) => {
    if (!(error instanceof UniqueConstraintError)) throw error;
    const [existing] = await sequelize.query(
      `SELECT id, btrim(name) AS name FROM route_profiles
       WHERE user_id = :userId AND lower(btrim(name)) = lower(btrim(:name)) AND id <> :editedId
       ORDER BY id LIMIT 1`,
      {
        replacements: { userId, name, editedId: editedId ?? 0 },
        type: sequelize.QueryTypes.SELECT
      }
    );
    const message = `Ya tienes una ruta llamada «${existing?.name ?? name}».`;
    const duplicate = httpError(409, message, { name: message });
    if (existing) duplicate.existingId = existing.id;
    throw duplicate;
  });
}

// The presets are copied once per user: the lock keeps two first requests from copying them twice.
async function seedPresets(userId) {
  await sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, {
      attributes: ['id', 'routeProfilesSeeded'],
      lock: transaction.LOCK.UPDATE,
      transaction
    });
    if (!user) throw httpError(401, 'Necesitas iniciar sesión.');
    if (user.routeProfilesSeeded) return;
    await RouteProfile.bulkCreate(
      PRESET_PROFILES.map(({ presetKey, name, weights, maxDetourPercentage }) => ({
        userId,
        name,
        presetKey,
        ...weightColumns(weights),
        maxDetourPercentage
      })),
      { transaction, ignoreDuplicates: true }
    );
    await user.update({ routeProfilesSeeded: true }, { transaction });
  });
}

async function listForUser(userId) {
  await seedPresets(userId);
  const rows = await RouteProfile.findAll({
    where: { userId },
    attributes: ATTRIBUTES,
    order: [['id', 'ASC']],
    raw: true
  });
  return rows.map(toProfile);
}

function countForUser(userId) {
  return RouteProfile.count({ where: { userId } });
}

async function createForUser(userId, { name, weights, maxDetourPercentage }) {
  const row = await withDuplicateName(
    RouteProfile.create({
      userId,
      name,
      ...weightColumns(weights),
      maxDetourPercentage
    }),
    userId,
    name
  );
  return toProfile(row.get({ plain: true }));
}

async function updateForUser(userId, id, { name, weights, maxDetourPercentage }) {
  const [updated] = await withDuplicateName(
    RouteProfile.update(
      { name, ...weightColumns(weights), maxDetourPercentage },
      { where: { id, userId } }
    ),
    userId,
    name,
    id
  );
  if (!updated) return null;
  return toProfile(await RouteProfile.findByPk(id, { attributes: ATTRIBUTES, raw: true }));
}

async function deleteForUser(userId, id) {
  return (await RouteProfile.destroy({ where: { id, userId } })) > 0;
}

module.exports = { countForUser, createForUser, deleteForUser, listForUser, updateForUser };
