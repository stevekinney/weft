import {
  DEFAULT_CLOCK_TOLERANCE,
  type JWTAlgorithm,
  type JWTConfig,
  type JWTPayload,
} from './types.ts';

type HMACAlgorithm = Extract<JWTAlgorithm, 'HS256' | 'HS384' | 'HS512'>;
type RSAAlgorithm = Extract<JWTAlgorithm, 'RS256' | 'RS384' | 'RS512'>;
type ECDSAAlgorithm = Extract<JWTAlgorithm, 'ES256' | 'ES384' | 'ES512'>;

const HMAC_IMPORT_PARAMS: Record<HMACAlgorithm, HmacImportParams> = {
  HS256: { name: 'HMAC', hash: 'SHA-256' },
  HS384: { name: 'HMAC', hash: 'SHA-384' },
  HS512: { name: 'HMAC', hash: 'SHA-512' },
};

const RSA_IMPORT_PARAMS: Record<RSAAlgorithm, RsaHashedImportParams> = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
};

const ECDSA_IMPORT_PARAMS: Record<ECDSAAlgorithm, EcKeyImportParams> = {
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
  ES384: { name: 'ECDSA', namedCurve: 'P-384' },
  ES512: { name: 'ECDSA', namedCurve: 'P-521' },
};

function getImportParams(
  algorithm: JWTAlgorithm,
): HmacImportParams | RsaHashedImportParams | EcKeyImportParams {
  if (algorithm in HMAC_IMPORT_PARAMS) return HMAC_IMPORT_PARAMS[algorithm as HMACAlgorithm];
  if (algorithm in RSA_IMPORT_PARAMS) return RSA_IMPORT_PARAMS[algorithm as RSAAlgorithm];
  return ECDSA_IMPORT_PARAMS[algorithm as ECDSAAlgorithm];
}

function getVerifyParams(algorithm: JWTAlgorithm): AlgorithmIdentifier | EcdsaParams {
  if (algorithm.startsWith('ES')) {
    return { name: 'ECDSA', hash: `SHA-${algorithm.slice(2)}` };
  }
  return getImportParams(algorithm);
}

/**
 * Encode a string to an `ArrayBuffer` for use with Web Crypto APIs.
 *
 * `TextEncoder.encode().buffer` is typed as `ArrayBufferLike` (which includes
 * `SharedArrayBuffer`), but `crypto.subtle` expects `BufferSource`. Copying
 * into a fresh `ArrayBuffer` gives a properly typed result without needing
 * a type assertion that conflicts between tsc and oxlint.
 */
function textToBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

/** Decode a binary string (from `atob`) into a fresh `ArrayBuffer`. */
function binaryStringToBuffer(binary: string): ArrayBuffer {
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function base64UrlDecode(input: string): ArrayBuffer {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return binaryStringToBuffer(atob(padded));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parsePEM(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  return binaryStringToBuffer(atob(base64));
}

/** Import a CryptoKey from JWT configuration for signature verification. */
export async function importJWTKey(config: JWTConfig): Promise<CryptoKey> {
  const algorithm = config.algorithm ?? 'HS256';
  const params = getImportParams(algorithm);

  if (algorithm.startsWith('HS')) {
    if (!config.secret) {
      throw new Error('JWT configuration requires "secret" for HMAC algorithms');
    }
    return crypto.subtle.importKey('raw', textToBuffer(config.secret), params, false, ['verify']);
  }

  if (!config.publicKey) {
    throw new Error('JWT configuration requires "publicKey" for RSA/ECDSA algorithms');
  }
  return crypto.subtle.importKey('spki', parsePEM(config.publicKey), params, false, ['verify']);
}

/** Sign a JWT payload. Primarily for testing. */
export async function signJWT(
  payload: JWTPayload,
  secret: string,
  algorithm: JWTAlgorithm = 'HS256',
): Promise<string> {
  const header = { alg: algorithm, typ: 'JWT' };
  const headerB64 = base64UrlEncode(textToBuffer(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(textToBuffer(JSON.stringify(payload)));
  const signingInput = textToBuffer(`${headerB64}.${payloadB64}`);

  const params = getImportParams(algorithm);
  const key = await crypto.subtle.importKey('raw', textToBuffer(secret), params, false, ['sign']);

  const signature = await crypto.subtle.sign(params, key, signingInput);
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

function validateTemporalClaims(payload: JWTPayload, config: JWTConfig): void {
  const now = Math.floor(Date.now() / 1000);
  const tolerance = config.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;

  if (typeof payload['exp'] === 'number' && now > payload['exp'] + tolerance) {
    throw new Error('JWT expired');
  }

  if (typeof payload['nbf'] === 'number' && now < payload['nbf'] - tolerance) {
    throw new Error('JWT not yet valid');
  }
}

function validateClaimsIdentity(payload: JWTPayload, config: JWTConfig): void {
  if (config.issuer !== undefined && payload['iss'] !== config.issuer) {
    throw new Error(`Invalid issuer: expected "${config.issuer}", got "${String(payload['iss'])}"`);
  }

  if (config.audience !== undefined) {
    const aud = Array.isArray(payload['aud']) ? payload['aud'] : [payload['aud']];
    if (!aud.includes(config.audience)) {
      throw new Error(`Invalid audience: expected "${config.audience}"`);
    }
  }
}

/** Verify a JWT token and return its decoded payload. */
export async function verifyJWT(
  token: string,
  key: CryptoKey,
  config: JWTConfig,
): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as {
    alg?: string;
    typ?: string;
  };
  const expectedAlgorithm = config.algorithm ?? 'HS256';

  if (header.alg !== expectedAlgorithm) {
    throw new Error(`Algorithm mismatch: expected ${expectedAlgorithm}, got ${header.alg}`);
  }

  const signingInput = textToBuffer(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const verifyParams = getVerifyParams(expectedAlgorithm);

  const valid = await crypto.subtle.verify(verifyParams, key, signature, signingInput);
  if (!valid) {
    throw new Error('Invalid JWT signature');
  }

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as JWTPayload;
  validateTemporalClaims(payload, config);
  validateClaimsIdentity(payload, config);
  return payload;
}
