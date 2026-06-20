/**
 * Sync cryptography.
 *
 * All primitives come from libsodium — nothing hand-rolled. The master password
 * is stretched once with Argon2id (`crypto_pwhash`) into a master key, which is
 * then split with `crypto_kdf` into two independent subkeys: one for
 * client-side encryption, one for server authentication. The two roles never
 * share a secret. Content is sealed with XChaCha20-Poly1305
 * (`crypto_aead_xchacha20poly1305_ietf`), so the server only ever sees opaque
 * ciphertext plus the auth token and has no path to the plaintext.
 */
import _sodium from 'libsodium-wrappers';

export interface DerivedKeys {
  /** Encrypts/decrypts sync content. Never leaves the device. */
  readonly encKey: Uint8Array;
  /** Authenticates to the server. Safe to send; cannot decrypt content. */
  readonly authKey: Uint8Array;
  /** Hex form of the auth key, used as the server credential. */
  readonly authToken: string;
}

let ready: Promise<typeof _sodium> | null = null;

async function sodium(): Promise<typeof _sodium> {
  if (!ready) {
    ready = _sodium.ready.then(() => _sodium);
  }
  return ready;
}

export async function generateSalt(): Promise<Uint8Array> {
  const s = await sodium();
  return s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
}

const KDF_CONTEXT = 'harbrSyn'; // exactly 8 bytes, required by crypto_kdf

export async function deriveKeys(password: string, salt: Uint8Array): Promise<DerivedKeys> {
  const s = await sodium();
  const master = s.crypto_pwhash(
    s.crypto_kdf_KEYBYTES,
    password,
    salt,
    s.crypto_pwhash_OPSLIMIT_MODERATE,
    s.crypto_pwhash_MEMLIMIT_MODERATE,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
  const encKey = s.crypto_kdf_derive_from_key(s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 1, KDF_CONTEXT, master);
  const authKey = s.crypto_kdf_derive_from_key(32, 2, KDF_CONTEXT, master);
  return { encKey, authKey, authToken: s.to_hex(authKey) };
}

/** Seal plaintext as `nonce || ciphertext`. */
export async function encrypt(encKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const cipher = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, encKey);
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0);
  out.set(cipher, nonce.length);
  return out;
}

/** Open a `nonce || ciphertext` blob. Throws on tamper/wrong key. */
export async function decrypt(encKey: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const s = await sodium();
  const npub = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = blob.subarray(0, npub);
  const cipher = blob.subarray(npub);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, cipher, null, nonce, encKey);
}
