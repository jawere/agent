import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile, mkdir, access, chmod } from 'fs/promises';
import { constants } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join } from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'jawere-agent-key-vault-2026';
const PEPPER_FILE = join(homedir(), '.jawere', '.pepper');

/** Load or generate a random 32-byte pepper stored on disk. This ensures
 *  the encryption key cannot be derived from hostname+username alone. */
async function loadOrCreatePepper(): Promise<Buffer> {
  try {
    await access(PEPPER_FILE, constants.R_OK);
    return await readFile(PEPPER_FILE);
  } catch {
    const pepper = randomBytes(32);
    await mkdir(join(homedir(), '.jawere'), { recursive: true });
    await writeFile(PEPPER_FILE, pepper);
    // Restrict permissions so only the owner can read the pepper
    try { await chmod(PEPPER_FILE, 0o600); } catch { /* best effort */ }
    return pepper;
  }
}

let _pepper: Buffer | null = null;

/** Derive a 256-bit key from machine identity + random pepper.
 *  The pepper adds 256 bits of entropy that can't be guessed from hostname/username. */
async function deriveKey(): Promise<Buffer> {
  if (!_pepper) _pepper = await loadOrCreatePepper();
  const machineId = `${hostname()}-${userInfo().username}-jawere`;
  return scryptSync(machineId, Buffer.concat([Buffer.from(SALT), _pepper]), 32);
}

/** Encrypt a string and return base64-encoded ciphertext (iv + tag + data). */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv (16) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** Decrypt a base64-encoded ciphertext. Returns null if decryption fails. */
export async function decrypt(encoded: string): Promise<string | null> {
  try {
    const key = await deriveKey();
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf-8');
  } catch {
    return null;
  }
}

const KEY_FILE = join(homedir(), '.jawere', 'key.enc');

/** Save encrypted API key to ~/.jawere/key.enc */
export async function saveKey(apiKey: string): Promise<void> {
  const dir = join(homedir(), '.jawere');
  await mkdir(dir, { recursive: true });
  const encrypted = await encrypt(apiKey.trim());
  await writeFile(KEY_FILE, encrypted, 'utf-8');
  // Restrict permissions so only the owner can read the key and directory
  try { await chmod(KEY_FILE, 0o600); } catch { /* best effort */ }
  try { await chmod(dir, 0o700); } catch { /* best effort */ }
}

/** Load and decrypt API key from ~/.jawere/key.enc. Returns null if not found or corrupt. */
export async function loadKey(): Promise<string | null> {
  try {
    await access(KEY_FILE, constants.R_OK);
    const encrypted = await readFile(KEY_FILE, 'utf-8');
    return await decrypt(encrypted.trim());
  } catch {
    return null;
  }
}

/** Check if a saved key exists */
export async function hasKey(): Promise<boolean> {
  try {
    await access(KEY_FILE, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Delete the saved key */
export async function deleteKey(): Promise<void> {
  try {
    const { unlink } = await import('fs/promises');
    await unlink(KEY_FILE);
  } catch {
    // Ignore if not found
  }
}
