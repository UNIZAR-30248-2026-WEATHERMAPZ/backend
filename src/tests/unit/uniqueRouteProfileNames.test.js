const {
  renameUserRoutes
} = require('../../repositories/migrations/20261112000003-unique-route-profile-names');

// Rows as the migration reads them: ordered by id, with the trimmed name and its key.
const row = (id, name) => ({
  id,
  name,
  trimmed: name.trim(),
  key: name.trim().toLowerCase()
});
const newNames = (rows) => renameUserRoutes(rows).map(({ newName, reason }) => [newName, reason]);

describe('migration unique-route-profile-names (#165)', () => {
  it('keeps the name for the oldest route and numbers the newer ones', () => {
    expect(newNames([row(1, 'Verano'), row(2, ' verano '), row(3, 'VERANO')])).toEqual([
      ['Verano', null],
      ['verano (2)', 'duplicate'],
      ['VERANO (3)', 'duplicate']
    ]);
  });

  it('skips the numbers already taken and trims the names it keeps', () => {
    expect(newNames([row(1, ' Verano'), row(2, 'Verano (2)'), row(3, 'verano')])).toEqual([
      ['Verano', null],
      ['Verano (2)', null],
      ['verano (3)', 'duplicate']
    ]);
  });

  it('renames "Recomendada", also when it is the only route', () => {
    expect(newNames([row(1, 'recomendada '), row(2, 'Recomendada (2)')])).toEqual([
      ['recomendada (3)', 'reserved'],
      ['Recomendada (2)', null]
    ]);
  });

  it('cuts the name so that it fits in 40 characters', () => {
    const long = 'Paseo largo por la ribera del Ebro norte';
    expect(long).toHaveLength(40);
    const [, [renamed]] = newNames([row(1, long), row(2, long.toUpperCase())]);
    expect(renamed).toBe('PASEO LARGO POR LA RIBERA DEL EBRO N (2)');
    expect(renamed).toHaveLength(40);
  });
});
