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
  'maxDetourPercentage'
];
const DUPLICATE_NAME = 'Ya tienes una ruta con ese nombre.';

function toProfile(row) {
  return {
    id: row.id,
    name: row.name,
    presetKey: row.presetKey,
    weights: { shade: row.shadeWeight, sun: row.sunWeight, wind: row.windWeight },
    maxDetourPercentage: row.maxDetourPercentage
  };
}

const weightColumns = (weights) => ({
  shadeWeight: weights.shade,
  sunWeight: weights.sun,
  windWeight: weights.wind ?? 0
});

function withDuplicateName(operation) {
  return operation.catch((error) => {
    if (error instanceof UniqueConstraintError) {
      throw httpError(409, DUPLICATE_NAME, { name: DUPLICATE_NAME });
    }
    throw error;
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
    })
  );
  return toProfile(row.get({ plain: true }));
}

async function updateForUser(userId, id, { name, weights, maxDetourPercentage }) {
  const [updated] = await withDuplicateName(
    RouteProfile.update(
      { name, ...weightColumns(weights), maxDetourPercentage },
      { where: { id, userId } }
    )
  );
  if (!updated) return null;
  return toProfile(await RouteProfile.findByPk(id, { attributes: ATTRIBUTES, raw: true }));
}

async function deleteForUser(userId, id) {
  return (await RouteProfile.destroy({ where: { id, userId } })) > 0;
}

module.exports = { countForUser, createForUser, deleteForUser, listForUser, updateForUser };
