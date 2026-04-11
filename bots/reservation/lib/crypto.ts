import crypto from 'crypto';
import { loadSecrets } from './secrets';

let keyCache: Buffer | null = null;

function getKey(): Buffer {
  if (!keyCache) {
    const secrets = loadSecrets();
    const hex = secrets.db_encryption_key;
    if (!hex || String(hex).length !== 64) {
      throw new Error('db_encryption_key must be 64-char hex in secrets.json');
    }
    keyCache = Buffer.from(String(hex), 'hex');
  }
  return keyCache;
}

export function encrypt(text: unknown): string | null {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(text), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const buffer = Buffer.from(value, 'base64');
    const iv = buffer.slice(0, 12);
    const authTag = buffer.slice(12, 28);
    const data = buffer.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(authTag);
    return decipher.update(data) + decipher.final('utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`decrypt 실패: ${message}`);
  }
}

function normalizeKioskKeyPart(value: unknown): string {
  return String(value || '').trim();
}

export function hashKioskKeyLegacy(phoneRaw: unknown, date: unknown, start: unknown): string {
  const secrets = loadSecrets();
  const pepper = secrets.db_key_pepper || '';
  return crypto
    .createHash('sha256')
    .update(
      `${normalizeKioskKeyPart(phoneRaw)}|${normalizeKioskKeyPart(date)}|${normalizeKioskKeyPart(start)}${pepper}`
    )
    .digest('hex');
}

export function hashKioskKey(
  phoneRaw: unknown,
  date: unknown,
  start: unknown,
  end: unknown,
  room: unknown,
): string {
  const secrets = loadSecrets();
  const pepper = secrets.db_key_pepper || '';
  return crypto
    .createHash('sha256')
    .update(
      [
        normalizeKioskKeyPart(phoneRaw),
        normalizeKioskKeyPart(date),
        normalizeKioskKeyPart(start),
        normalizeKioskKeyPart(end),
        normalizeKioskKeyPart(room),
      ].join('|') + pepper,
    )
    .digest('hex');
}
