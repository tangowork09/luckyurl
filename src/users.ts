/**
 * User accounts + password hashing.
 *
 * Passwords are hashed with scrypt (node:crypto), one random salt per user,
 * compared with timingSafeEqual. users.json lives in DATA_DIR, keyed by a
 * random hex id; email is stored lowercased and treated as unique.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './jsonstore';

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  passwordHash: string; // hex
  salt: string; // hex
  role: UserRole;
  createdAt: string;
  /** Optional contact phone (used for Cashfree customer_details when present). */
  phone?: string;
  /**
   * Whether the email has been confirmed. Defaults to true today so the
   * no-verify UX is unchanged; enforcement is gated behind
   * REQUIRE_EMAIL_VERIFICATION (off). See TODO(email-verification) in server.ts.
   */
  emailVerified: boolean;
  /**
   * Session-revocation counter embedded in the signed cookie. Bumped on logout
   * and password change so old cookies stop validating (see auth.ts). Older
   * records without this field are treated as version 0.
   */
  tokenVersion: number;
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt);
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(password: string, hashHex: string, saltHex: string): Promise<boolean> {
  const derived = await scryptAsync(password, saltHex);
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch — guard first, still constant-time on equal length.
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export class UserStore {
  private store: JsonStore<User>;

  constructor(dataDir: string) {
    this.store = new JsonStore<User>(join(dataDir, 'users.json'));
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  async byId(id: string): Promise<User | undefined> {
    await this.load();
    return this.store.get(id);
  }

  async byEmail(email: string): Promise<User | undefined> {
    await this.load();
    const e = email.toLowerCase();
    return this.store.find((u) => u.email === e);
  }

  async all(): Promise<User[]> {
    await this.load();
    return this.store.all();
  }

  async hasAdmin(): Promise<boolean> {
    await this.load();
    return this.store.all().some((u) => u.role === 'admin');
  }

  async create(input: { email: string; password: string; role?: UserRole; phone?: string }): Promise<User> {
    const email = input.email.toLowerCase();
    if (await this.byEmail(email)) throw new Error('An account with that email already exists.');
    const { hash, salt } = await hashPassword(input.password);
    const user: User = {
      id: randomBytes(12).toString('hex'),
      email,
      passwordHash: hash,
      salt,
      role: input.role ?? 'user',
      createdAt: new Date().toISOString(),
      phone: input.phone,
      // Default verified so the current no-verify signup flow is unchanged.
      emailVerified: true,
      tokenVersion: 0,
    };
    await this.store.put(user);
    return user;
  }

  /**
   * Change a user's password and bump tokenVersion (invalidating every other
   * session). Returns the updated user, or undefined if the id is unknown.
   */
  async updatePassword(id: string, newPassword: string): Promise<User | undefined> {
    const u = await this.byId(id);
    if (!u) return undefined;
    const { hash, salt } = await hashPassword(newPassword);
    const updated: User = { ...u, passwordHash: hash, salt, tokenVersion: (u.tokenVersion ?? 0) + 1 };
    await this.store.put(updated);
    return updated;
  }

  /** Bump tokenVersion to revoke all outstanding sessions (e.g. on logout). */
  async bumpTokenVersion(id: string): Promise<User | undefined> {
    const u = await this.byId(id);
    if (!u) return undefined;
    const updated: User = { ...u, tokenVersion: (u.tokenVersion ?? 0) + 1 };
    await this.store.put(updated);
    return updated;
  }

  /** Public projection safe to send to the client. */
  static publicView(u: User): { id: string; email: string; role: UserRole; createdAt: string } {
    return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt };
  }
}
