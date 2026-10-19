import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM for individual column values: "iv.tag.ciphertext" (base64url). */
export function encryptField(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptField(key: Buffer, payload: string): string {
  const [iv, tag, data] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** "0123456789" → "••••••6789" */
export function mask(value: string, visible = 4): string {
  const v = value.replace(/\s/g, '');
  return v.length <= visible ? v : `${'•'.repeat(Math.min(6, v.length - visible))}${v.slice(-visible)}`;
}
