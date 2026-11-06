const { sequelize } = require('../../config/database');
const routeProfileRepository = require('../../repositories/routeProfileRepository');
const userRepository = require('../../repositories/userRepository');

const newUser = (email) => userRepository.createUser({ name: 'Ana', email, passwordHash: 'x' });

describe('route profiles (PostgreSQL)', () => {
  beforeEach(async () => {
    await sequelize.query('TRUNCATE users, route_profiles RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('gives each user their own copy of the presets, only once', async () => {
    const ana = await newUser('ana@correo.es');
    const luis = await newUser('luis@correo.es');

    const [first, again, other] = await Promise.all([
      routeProfileRepository.listForUser(ana.id),
      routeProfileRepository.listForUser(ana.id),
      routeProfileRepository.listForUser(luis.id)
    ]);

    expect(first.map(({ name, presetKey, weights }) => [name, presetKey, weights])).toEqual([
      ['Rápida', 'fastest', { shade: 0, sun: 0, wind: 0 }],
      ['Sombreada', 'shaded', { shade: 50, sun: 0, wind: 0 }],
      ['Soleada', 'sunny', { shade: 0, sun: 50, wind: 0 }]
    ]);
    expect(again).toEqual(first);
    expect(other).toHaveLength(3);
    expect(other[0].id).not.toBe(first[0].id);
  });

  it('deletes a preset only for its user, and it does not come back', async () => {
    const ana = await newUser('ana@correo.es');
    const luis = await newUser('luis@correo.es');
    const [, shaded] = await routeProfileRepository.listForUser(ana.id);
    await routeProfileRepository.listForUser(luis.id);

    expect(await routeProfileRepository.deleteForUser(luis.id, shaded.id)).toBe(false);
    expect(await routeProfileRepository.deleteForUser(ana.id, shaded.id)).toBe(true);

    expect((await routeProfileRepository.listForUser(ana.id)).map(({ name }) => name)).toEqual([
      'Rápida',
      'Soleada'
    ]);
    expect(await routeProfileRepository.listForUser(luis.id)).toHaveLength(3);
  });

  it('creates and edits routes of the user with unique names', async () => {
    const ana = await newUser('ana@correo.es');
    await routeProfileRepository.listForUser(ana.id);

    const summer = await routeProfileRepository.createForUser(ana.id, {
      name: 'Verano',
      weights: { shade: 80, sun: 0 },
      maxDetourPercentage: 10
    });
    expect(summer).toMatchObject({ maxDetourPercentage: 10 });
    expect(summer).toMatchObject({
      name: 'Verano',
      presetKey: null,
      weights: { shade: 80, sun: 0 }
    });

    await expect(
      routeProfileRepository.createForUser(ana.id, {
        name: 'verano',
        weights: { shade: 1, sun: 0 }
      })
    ).rejects.toMatchObject({ status: 409 });

    const edited = await routeProfileRepository.updateForUser(ana.id, summer.id, {
      name: 'Verano fuerte',
      weights: { shade: 100, sun: 0 },
      maxDetourPercentage: 40
    });
    expect(edited.maxDetourPercentage).toBe(40);
    expect(edited).toMatchObject({ id: summer.id, name: 'Verano fuerte', weights: { shade: 100 } });
    const windy = await routeProfileRepository.updateForUser(ana.id, summer.id, {
      name: 'Cierzo',
      weights: { shade: 0, sun: 0, wind: 70 },
      maxDetourPercentage: 25
    });
    expect(windy.weights).toEqual({ shade: 0, sun: 0, wind: 70 });
    await expect(
      routeProfileRepository.updateForUser(ana.id, summer.id, {
        name: 'Sombreada',
        weights: { shade: 1, sun: 0 }
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(await routeProfileRepository.countForUser(ana.id)).toBe(4);
  });

  it('does not edit the route of another user', async () => {
    const ana = await newUser('ana@correo.es');
    const luis = await newUser('luis@correo.es');
    const [fastest] = await routeProfileRepository.listForUser(ana.id);

    expect(
      await routeProfileRepository.updateForUser(luis.id, fastest.id, {
        name: 'Mía',
        weights: { shade: 0, sun: 0 }
      })
    ).toBeNull();
  });

  it('removes the routes with their user', async () => {
    const ana = await newUser('ana@correo.es');
    await routeProfileRepository.listForUser(ana.id);

    await sequelize.query('DELETE FROM users');

    const [{ count }] = await sequelize.query('SELECT count(*)::int AS count FROM route_profiles', {
      type: 'SELECT'
    });
    expect(count).toBe(0);
  });

  it('rejects weights outside 0-100 in the database too', async () => {
    const ana = await newUser('ana@correo.es');

    await expect(
      sequelize.query(
        `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight) VALUES (${ana.id}, 'Mal', 101, 0)`
      )
    ).rejects.toThrow();
    await expect(
      sequelize.query(
        `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight, wind_weight) VALUES (${ana.id}, 'Mal', 0, 0, 101)`
      )
    ).rejects.toThrow();
  });

  it('gives a wind weight of 0 to routes saved without one', async () => {
    const ana = await newUser('ana@correo.es');
    await sequelize.query(
      `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight) VALUES (${ana.id}, 'Antigua', 30, 0)`
    );

    const [old] = await routeProfileRepository.listForUser(ana.id);

    expect(old).toMatchObject({ name: 'Antigua', weights: { shade: 30, sun: 0, wind: 0 } });
  });
});
