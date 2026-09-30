import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  type ScryptOptions,
} from "node:crypto";
import { ConfigurationError, SessionCorruptedError } from "../errors/errors.js";

/**
 * Transforms serialized session bytes before they are written (and back after reading).
 * Used for optional encryption at rest.
 */
export interface SessionCodec {
  /** Stable identifier stored in the file envelope, so the wrong codec is detected on load. */
  readonly id: string;
  encode(plaintext: Uint8Array): Promise<Uint8Array>;
  decode(encoded: Uint8Array): Promise<Uint8Array>;
}

/** No transformation. The file is still checksummed and written atomically. */
export const plainCodec: SessionCodec = Object.freeze({
  id: "none",
  encode: (plaintext: Uint8Array) => Promise.resolve(plaintext),
  decode: (encoded: Uint8Array) => Promise.resolve(encoded),
});

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

function encryptAesGcm(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decryptAesGcm(key: Uint8Array, encoded: Uint8Array): Uint8Array {
  if (encoded.byteLength < IV_BYTES + TAG_BYTES) {
    throw new SessionCorruptedError("Encrypted session is truncated");
  }
  const buf = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = buf.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (error) {
    throw new SessionCorruptedError("Could not decrypt session (wrong key, or the file was modified)", {
      cause: error,
    });
  }
}

/**
 * AES-256-GCM with a 32-byte key supplied by the application. A fresh random IV is used
 * for every save; the GCM tag authenticates the ciphertext.
 */
export function createAesGcmCodec(options: { key: Uint8Array }): SessionCodec {
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== KEY_BYTES) {
    throw new ConfigurationError("AES-GCM session key must be exactly 32 bytes");
  }
  const key = Uint8Array.from(options.key);
  return Object.freeze({
    id: "aes-256-gcm",
    encode: (plaintext: Uint8Array) => Promise.resolve(encryptAesGcm(key, plaintext)),
    decode: (encoded: Uint8Array) => Promise.resolve().then(() => decryptAesGcm(key, encoded)),
  });
}

const SCRYPT_PARAMS: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(passphrase: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase.normalize("NFKC"), salt, KEY_BYTES, SCRYPT_PARAMS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * AES-256-GCM keyed from a passphrase with scrypt (N=2^15, r=8, p=1). A random salt is
 * generated per save and stored alongside the ciphertext: salt(16) | iv(12) | tag(16) | body.
 */
export function createPassphraseCodec(options: { passphrase: string }): SessionCodec {
  if (typeof options.passphrase !== "string" || options.passphrase.length < 8) {
    throw new ConfigurationError("Session passphrase must be a string of at least 8 characters");
  }
  const { passphrase } = options;
  return Object.freeze({
    id: "scrypt-aes-256-gcm",
    encode: async (plaintext: Uint8Array) => {
      const salt = randomBytes(SALT_BYTES);
      const key = await scrypt(passphrase, salt);
      return Buffer.concat([salt, encryptAesGcm(key, plaintext)]);
    },
    decode: async (encoded: Uint8Array) => {
      if (encoded.byteLength < SALT_BYTES + IV_BYTES + TAG_BYTES) {
        throw new SessionCorruptedError("Encrypted session is truncated");
      }
      const buf = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      const key = await scrypt(passphrase, buf.subarray(0, SALT_BYTES));
      return decryptAesGcm(key, buf.subarray(SALT_BYTES));
    },
  });
}
