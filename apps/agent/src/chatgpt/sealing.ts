// The ChatGPT tokens at rest: AES-256-GCM under a key derived from CHATGPT_TOKEN_KEY, so a copy of
// the database alone can't use the sign-in. Each value is bound to its column, so one can't be
// moved into another; a value the key can't open (another key, or tampered) reads as missing.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SealedField = 'id_token' | 'access_token' | 'refresh_token';

export class TokenSealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, '', 'pantrymos chatgpt tokens v1', 32));
  }

  seal(field: SealedField, value: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(field));
    const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `${VERSION}.${iv.toString('base64url')}.${sealed.toString('base64url')}`;
  }

  /** The value, or null when this key can't open it. */
  open(field: SealedField, stored: string): string | null {
    const [version, iv, sealed, extra] = stored.split('.');
    if (version !== VERSION || !iv || !sealed || extra !== undefined) return null;
    const ivBytes = Buffer.from(iv, 'base64url');
    const bytes = Buffer.from(sealed, 'base64url');
    if (ivBytes.length !== IV_BYTES || bytes.length < TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, ivBytes);
      decipher.setAAD(Buffer.from(field));
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
