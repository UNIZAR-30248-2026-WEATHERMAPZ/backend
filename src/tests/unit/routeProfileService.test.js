const {
  MAX_PROFILES_PER_USER,
  createRouteProfileService
} = require('../../services/routing/routeProfileService');

describe('route profile service', () => {
  const repository = {
    listForUser: jest.fn(),
    countForUser: jest.fn(),
    createForUser: jest.fn(),
    updateForUser: jest.fn(),
    deleteForUser: jest.fn()
  };
  const service = createRouteProfileService(repository);
  const input = {
    name: 'Verano',
    weights: { shade: 80, sun: 0, wind: 0, vegetation: 0 },
    maxDetourPercentage: 25
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repository.countForUser.mockResolvedValue(3);
  });

  it('creates a route with validated values', async () => {
    repository.createForUser.mockResolvedValue({ id: 4, ...input });

    await expect(service.create(7, { ...input, name: ' Verano ' })).resolves.toMatchObject({
      id: 4
    });
    expect(repository.createForUser).toHaveBeenCalledWith(7, input);
  });

  it('limits how many routes a user can save', async () => {
    repository.countForUser.mockResolvedValue(MAX_PROFILES_PER_USER);

    await expect(service.create(7, input)).rejects.toMatchObject({ status: 409 });
    expect(repository.createForUser).not.toHaveBeenCalled();
  });

  it('does not save invalid weights', async () => {
    await expect(service.create(7, { name: 'Mal', weights: { sun: 150 } })).rejects.toMatchObject({
      status: 400
    });
    expect(repository.createForUser).not.toHaveBeenCalled();
  });

  it('does not save or update a route with shade and sun at once (ADR-030)', async () => {
    const both = { ...input, weights: { shade: 40, sun: 40, wind: 0 } };

    await expect(service.create(7, both)).rejects.toMatchObject({
      status: 400,
      fields: { shade: expect.any(String), sun: expect.any(String) }
    });
    await expect(service.update(7, 4, both)).rejects.toMatchObject({ status: 400 });
    expect(repository.createForUser).not.toHaveBeenCalled();
    expect(repository.updateForUser).not.toHaveBeenCalled();
  });

  it('updates only an existing route of the user', async () => {
    repository.updateForUser.mockResolvedValueOnce({ id: 4, ...input });
    await expect(service.update(7, '4', input)).resolves.toMatchObject({ id: 4 });
    expect(repository.updateForUser).toHaveBeenCalledWith(7, 4, input);

    repository.updateForUser.mockResolvedValueOnce(null);
    await expect(service.update(7, '5', input)).rejects.toMatchObject({ status: 404 });
  });

  it('deletes only an existing route of the user', async () => {
    repository.deleteForUser.mockResolvedValueOnce(true);
    await expect(service.remove(7, '4')).resolves.toBeUndefined();

    repository.deleteForUser.mockResolvedValueOnce(false);
    await expect(service.remove(7, '4')).rejects.toMatchObject({ status: 404 });
  });

  it.each(['abc', '0', '-1', '1.5', '99999999999'])('treats id %s as not found', async (id) => {
    await expect(service.remove(7, id)).rejects.toMatchObject({ status: 404 });
    expect(repository.deleteForUser).not.toHaveBeenCalled();
  });
});
