const { sequelize } = require('../../config/database');
const routeProfileRepository = require('../../repositories/routeProfileRepository');
const userRepository = require('../../repositories/userRepository');
const exclusiveShadeSun = require('../../repositories/migrations/20261112000001-exclusive-shade-sun');
const uniqueNames = require('../../repositories/migrations/20261112000003-unique-route-profile-names');

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
      ['Rápida', 'fastest', { shade: 0, sun: 0, wind: 0, vegetation: 0 }],
      ['Sombreada', 'shaded', { shade: 50, sun: 0, wind: 0, vegetation: 0 }],
      ['Soleada', 'sunny', { shade: 0, sun: 50, wind: 0, vegetation: 0 }]
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
    expect(windy.weights).toEqual({ shade: 0, sun: 0, wind: 70, vegetation: 0 });
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

  it('migration exclusive-shade-sun keeps the larger weight and then forbids both (ADR-030)', async () => {
    const queryInterface = sequelize.getQueryInterface();
    const ana = await newUser('ana@correo.es');
    // Without the constraint, as before the migration, with routes saved with both weights.
    await exclusiveShadeSun.down(queryInterface);
    await sequelize.query(
      `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight) VALUES
         (${ana.id}, 'Más sombra', 60, 20),
         (${ana.id}, 'Más sol', 10, 70),
         (${ana.id}, 'Empate', 40, 40),
         (${ana.id}, 'Solo sombra', 50, 0)`
    );

    const fixed = await exclusiveShadeSun.up(queryInterface);

    expect(fixed).toBe(3);
    const [rows] = await sequelize.query(
      'SELECT name, shade_weight AS shade, sun_weight AS sun FROM route_profiles ORDER BY id'
    );
    expect(rows).toEqual([
      { name: 'Más sombra', shade: 60, sun: 0 },
      { name: 'Más sol', shade: 0, sun: 70 },
      { name: 'Empate', shade: 0, sun: 0 },
      { name: 'Solo sombra', shade: 50, sun: 0 }
    ]);
    await expect(
      sequelize.query(
        `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight) VALUES (${ana.id}, 'Mal', 30, 30)`
      )
    ).rejects.toThrow(/route_profiles_exclusive_shade_sun/);
  });

  it('saves the vegetation weight, 0 for the presets and the routes saved without one', async () => {
    const ana = await newUser('ana@correo.es');
    const presets = await routeProfileRepository.listForUser(ana.id);
    expect(presets.every(({ weights }) => weights.vegetation === 0)).toBe(true);

    const green = await routeProfileRepository.createForUser(ana.id, {
      name: 'Verde',
      weights: { shade: 0, sun: 0, wind: 0, vegetation: 70 },
      maxDetourPercentage: 25
    });
    expect(green.weights).toEqual({ shade: 0, sun: 0, wind: 0, vegetation: 70 });
    const updated = await routeProfileRepository.updateForUser(ana.id, green.id, {
      name: 'Verde',
      weights: { shade: 30, sun: 0, wind: 0, vegetation: 100 },
      maxDetourPercentage: 10
    });
    expect(updated.weights).toEqual({ shade: 30, sun: 0, wind: 0, vegetation: 100 });

    await sequelize.query(
      `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight) VALUES (${ana.id}, 'Antigua', 20, 0)`
    );
    const all = await routeProfileRepository.listForUser(ana.id);
    expect(all.find(({ name }) => name === 'Antigua').weights.vegetation).toBe(0);
    await expect(
      sequelize.query(
        `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight, vegetation_weight) VALUES (${ana.id}, 'Mal', 0, 0, 101)`
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
  // Repeated names of the saved routes (#165).
  const weights = { shade: 0, sun: 0, wind: 0, vegetation: 0 };

  it('says which route has the name, without case or surrounding spaces', async () => {
    const ana = await newUser('ana@correo.es');
    const [fastest] = await routeProfileRepository.listForUser(ana.id);
    const summer = await routeProfileRepository.createForUser(ana.id, {
      name: 'Verano',
      weights,
      maxDetourPercentage: 25
    });

    // The API trims the name; the index also ignores the spaces of a name saved with them.
    await sequelize.query(`UPDATE route_profiles SET name = ' Verano ' WHERE id = ${summer.id}`);
    await expect(
      routeProfileRepository.createForUser(ana.id, {
        name: 'VERANO',
        weights,
        maxDetourPercentage: 25
      })
    ).rejects.toMatchObject({
      status: 409,
      message: 'Ya tienes una ruta llamada «Verano».',
      fields: { name: 'Ya tienes una ruta llamada «Verano».' },
      existingId: summer.id
    });
    // Renaming another route to the name of a preset copied to the user.
    await expect(
      routeProfileRepository.updateForUser(ana.id, summer.id, {
        name: 'rápida',
        weights,
        maxDetourPercentage: 25
      })
    ).rejects.toMatchObject({ status: 409, existingId: fastest.id });
    // Its own name, with other case, is not a repetition; accents still count.
    await expect(
      routeProfileRepository.updateForUser(ana.id, summer.id, {
        name: 'VERANO',
        weights,
        maxDetourPercentage: 25
      })
    ).resolves.toMatchObject({ name: 'VERANO' });
    await expect(
      routeProfileRepository.createForUser(ana.id, {
        name: 'Rapida',
        weights,
        maxDetourPercentage: 25
      })
    ).resolves.toMatchObject({ name: 'Rapida' });
    // Another user may use the same name.
    const luis = await newUser('luis@correo.es');
    await expect(
      routeProfileRepository.createForUser(luis.id, {
        name: 'Verano',
        weights,
        maxDetourPercentage: 25
      })
    ).resolves.toMatchObject({ name: 'Verano' });
  });

  it('migration unique-route-profile-names fixes the names saved before and logs how many', async () => {
    const queryInterface = sequelize.getQueryInterface();
    const ana = await newUser('ana@correo.es');
    const luis = await newUser('luis@correo.es');
    // The index as before (lower(name)): it let through names that only differ in spaces.
    await uniqueNames.down(queryInterface);
    await sequelize.query(
      `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight) VALUES
         (${ana.id}, 'Verano', 50, 0),
         (${ana.id}, ' verano ', 30, 0),
         (${ana.id}, 'Recomendada', 0, 0),
         (${ana.id}, ' Otoño', 0, 20),
         (${luis.id}, 'Verano ', 10, 0)`
    );

    const counts = await uniqueNames.up(queryInterface);

    expect(counts).toEqual({ trimmed: 3, duplicates: 1, reserved: 1 });
    const [rows] = await sequelize.query(
      'SELECT user_id AS "userId", name, shade_weight AS shade FROM route_profiles ORDER BY id'
    );
    expect(rows).toEqual([
      { userId: ana.id, name: 'Verano', shade: 50 },
      { userId: ana.id, name: 'verano (2)', shade: 30 },
      { userId: ana.id, name: 'Recomendada (2)', shade: 0 },
      { userId: ana.id, name: 'Otoño', shade: 0 },
      { userId: luis.id, name: 'Verano', shade: 10 }
    ]);
    await expect(
      sequelize.query(
        `INSERT INTO route_profiles (user_id, name, shade_weight, sun_weight) VALUES (${ana.id}, ' VERANO', 0, 0)`
      )
    ).rejects.toMatchObject({ original: { constraint: 'route_profiles_user_name_idx' } });
  });
});
