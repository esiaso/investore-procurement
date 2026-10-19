import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { loadEnv } from '../../config/env';

// Accept the previous/next 30 s step to tolerate clock drift.
authenticator.options = { window: 1 };

@Injectable()
export class TotpService {
  private readonly key = loadEnv().totpEncryptionKey;

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  async enrolment(secret: string, username: string, issuer: string) {
    const otpauthUrl = authenticator.keyuri(username, issuer, secret);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  }

  verify(code: string, secret: string): boolean {
    try {
      return authenticator.verify({ token: code, secret });
    } catch {
      return false;
    }
  }

  /** Test/seed helper. */
  currentCode(secret: string): string {
    return authenticator.generate(secret);
  }

  encrypt(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(payload: string): string {
    const [iv, tag, data] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
