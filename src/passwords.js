// Password hashing (bcryptjs: pure JS, no native build on the shared host).
// Never log a password or a hash.

import bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'node:crypto';

export const BCRYPT_COST = 12;

// bcrypt only looks at the first 72 bytes; longer passwords are refused instead of
// being silently truncated.
export const MAX_PASSWORD_BYTES = 72;
export function passwordTooLong(password) {
  return Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES;
}

export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// No look-alike characters (0/O, 1/l/I) so the password can be read off a screen.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const GENERATED_PASSWORD_LENGTH = 20; // ~116 bits

export function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// A real cost-12 hash of a random secret: comparing against it when the username
// does not exist takes as long as a wrong password for a real user. Started when
// the routes are mounted (in the background); callers await the same promise.
let dummyHashPromise;
export function dummyHash() {
  dummyHashPromise ??= bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_COST).catch((err) => {
    dummyHashPromise = undefined; // let the next call try again instead of failing forever
    throw err;
  });
  return dummyHashPromise;
}
