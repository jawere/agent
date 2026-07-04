import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { constants } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join } from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'ponytail-agent-key-vault-2026';

/** Derive a 256-bit key from machine identity. Not perfect security but better than plaintext. */
function deriveKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-ponytail`;
  return scryptSync(machineId, SALT, 32);
}

/** Encrypt a string and return base64-encoded ciphertext (iv + tag + data). */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv (16) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** Decrypt a base64-encoded ciphertext. Returns null if decryption fails. */
export function decrypt(encoded: string): string | null {
  try {
    const key = deriveKey();
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

const KEY_FILE = join(homedir(), '.ponytail', 'key.enc');

/** Save encrypted API key to ~/.ponytail/key.enc */
export async function saveKey(apiKey: string): Promise<void> {
  const dir = join(homedir(), '.ponytail');
  await mkdir(dir, { recursive: true });
  const encrypted = encrypt(apiKey.trim());
  await writeFile(KEY_FILE, encrypted, 'utf-8');
}

/** Load and decrypt API key from ~/.ponytail/key.enc. Returns null if not found or corrupt. */
export async function loadKey(): Promise<string | null> {
  try {
    await access(KEY_FILE, constants.R_OK);
    const encrypted = await readFile(KEY_FILE, 'utf-8');
    return decrypt(encrypted.trim());
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
