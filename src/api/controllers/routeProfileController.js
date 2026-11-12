const { routeProfileService } = require('../../services/routing/routeProfileService');

/*
 * A repeated name (409) also says which route already has it, so the frontend can offer to
 * replace it. errorHandler only passes message and fields, so this answer is written here.
 */
function nextOrDuplicateName(error, res, next) {
  if (error.status === 409 && Number.isInteger(error.existingId)) {
    res.status(409).json({
      error: { message: error.message, fields: error.fields, existingId: error.existingId }
    });
    return;
  }
  next(error);
}

async function listRouteProfiles(req, res, next) {
  try {
    res.status(200).json({ profiles: await routeProfileService.list(req.userId) });
  } catch (error) {
    next(error);
  }
}

async function createRouteProfile(req, res, next) {
  try {
    res.status(201).json({ profile: await routeProfileService.create(req.userId, req.body) });
  } catch (error) {
    nextOrDuplicateName(error, res, next);
  }
}

async function updateRouteProfile(req, res, next) {
  try {
    const profile = await routeProfileService.update(req.userId, req.params.id, req.body);
    res.status(200).json({ profile });
  } catch (error) {
    nextOrDuplicateName(error, res, next);
  }
}

async function deleteRouteProfile(req, res, next) {
  try {
    await routeProfileService.remove(req.userId, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

module.exports = { createRouteProfile, deleteRouteProfile, listRouteProfiles, updateRouteProfile };
