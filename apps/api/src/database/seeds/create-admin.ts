import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import * as argon2 from 'argon2';
import { RoleCodes } from '@sil/shared';
import { DataSource } from 'typeorm';
import { RequestContext } from '../../common/request-context';
import { Role } from '../../modules/rbac/rbac.entities';
import { User } from '../../modules/users/user.entity';
import { typeOrmOptions } from '../typeorm-options';

/** A one-time password with every character class the password policy can ask for. */
export function oneTimePassword(length = 20): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '#%+=@!?-'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * The first administrator of a production installation (the reference seed
 * creates no users). The password is generated, shown once and must be changed
 * at first sign-in. Refuses an existing username.
 */
export async function createAdmin(ds: DataSource, input: { username: string; fullName: string; email?: string | null }): Promise<string> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) throw new Error('username: 3-50 characters, letters, digits, . _ -');
  const password = oneTimePassword();
  await RequestContext.run({ username: 'system:create-admin' }, () =>
    ds.transaction(async (m) => {
      if (await m.exists(User, { where: { username } })) throw new Error(`User ${username} already exists`);
      const role = await m.findOne(Role, { where: { code: RoleCodes.SYSTEM_ADMIN } });
      if (!role) throw new Error('Reference data is missing: run the seed (run-seed.js --reference-only) first');
      await m.save(
        m.create(User, {
          username,
          fullName: input.fullName,
          email: input.email ?? null,
          passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
          mustChangePassword: true,
          passwordChangedAt: null,
          roles: [role],
          stores: [],
        }),
      );
    }),
  );
  return password;
}

/** CLI: node dist/database/seeds/create-admin.js <username> "<full name>" [email] */
if (require.main === module) {
  const [username, fullName, email] = process.argv.slice(2);
  if (!username || !fullName) {
    console.error('usage: create-admin <username> "<full name>" [email]');
    process.exit(2);
  }
  (async () => {
    const ds = await new DataSource(typeOrmOptions()).initialize();
    try {
      const password = await createAdmin(ds, { username, fullName, email });
      console.log(`Created administrator ${username.toLowerCase()}. One-time password (shown once, must be changed at first sign-in):\n${password}`);
    } finally {
      await ds.destroy();
    }
  })().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
