import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadUserFromRequest, signSession, type AuthDeps } from '../src/auth';
import { UserStore, verifyPassword } from '../src/users';

let dir: string;
let users: UserStore;
const secret = 'session-secret-for-tests';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leadscout-session-'));
  users = new UserStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reqWithToken(token: string): Request {
  return { headers: { cookie: `ls_session=${token}` } } as unknown as Request;
}

function tokenFor(uid: string, tv: number): string {
  return signSession({ uid, exp: Date.now() + 60_000, tv }, secret);
}

describe('tokenVersion session revocation', () => {
  it('accepts a token whose version matches, rejects an older one after a bump', async () => {
    const u = await users.create({ email: 'a@example.com', password: 'password1' });
    const deps: AuthDeps = { users, sessionSecret: secret };
    const token = tokenFor(u.id, u.tokenVersion); // tv = 0

    expect(await loadUserFromRequest(reqWithToken(token), deps)).toBeDefined();

    await users.bumpTokenVersion(u.id); // logout / revoke → version 1
    expect(await loadUserFromRequest(reqWithToken(token), deps)).toBeUndefined();

    // A freshly-issued token at the new version works again.
    const fresh = tokenFor(u.id, 1);
    expect(await loadUserFromRequest(reqWithToken(fresh), deps)).toBeDefined();
  });

  it('treats a legacy token with no tv as version 0', async () => {
    const u = await users.create({ email: 'legacy@example.com', password: 'password1' });
    const deps: AuthDeps = { users, sessionSecret: secret };
    const noTv = signSession({ uid: u.id, exp: Date.now() + 60_000 }, secret); // no tv field
    expect(await loadUserFromRequest(reqWithToken(noTv), deps)).toBeDefined();
  });
});

describe('change-password (updatePassword) invalidates old sessions', () => {
  it('bumps tokenVersion and re-hashes the password', async () => {
    const u = await users.create({ email: 'c@example.com', password: 'oldpassword' });
    const deps: AuthDeps = { users, sessionSecret: secret };
    const oldToken = tokenFor(u.id, u.tokenVersion);
    expect(await loadUserFromRequest(reqWithToken(oldToken), deps)).toBeDefined();

    const updated = await users.updatePassword(u.id, 'newpassword');
    expect(updated!.tokenVersion).toBe(1);

    // Old cookie no longer validates; the new password verifies.
    expect(await loadUserFromRequest(reqWithToken(oldToken), deps)).toBeUndefined();
    expect(await verifyPassword('newpassword', updated!.passwordHash, updated!.salt)).toBe(true);
    expect(await verifyPassword('oldpassword', updated!.passwordHash, updated!.salt)).toBe(false);

    // A cookie re-issued at the new version (as change-password does) still works.
    const reissued = tokenFor(u.id, updated!.tokenVersion);
    expect(await loadUserFromRequest(reqWithToken(reissued), deps)).toBeDefined();
  });
});
