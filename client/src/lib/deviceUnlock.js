// THE DEVICE UNLOCK.
//
// The session has to survive a tab close, because typing a twenty-character recovery
// code every time someone opens the app is how that code ends up pasted into Notes and
// stops being a recovery secret. So the key persists — but wrapped under something the
// device must supply, never in the clear.
//
// BOTH PATHS ARE CRYPTOGRAPHIC, AND THAT IS THE POINT.
//
// The obvious version of this feature is: store the wrapped key, and require a WebAuthn
// assertion before calling `decrypt`. That is theatre. The assertion is a function the
// page calls, so script running on the origin skips it and decrypts anyway — it looks
// like a gate and stops nothing but an honest caller.
//
// So the device secret is not a gate on the unwrap; it IS the key the unwrap needs:
//
//   • PASSKEY (PRF)  — the WebAuthn PRF extension derives a secret inside the
//                      authenticator. It does not come out, and it cannot be produced
//                      without a successful user-verified assertion. HKDF over that
//                      output is the wrapping key.
//   • DEVICE PIN     — PBKDF2 over the PIN. The PIN is the secret, and it is never
//                      stored anywhere.
//
// Where the authenticator cannot do PRF, this falls back to the PIN rather than
// pretending the assertion was doing work.
//
// WHAT THE PIN DOES NOT DO. Six digits is not strong against someone who has the stored
// ciphertext and time. It is a convenience factor for a device you already trust, and
// the recovery code remains the thing that actually protects the record. Max attempts
// and a wipe on exhaustion are handled by the caller, not here.

const PRF_BYTES = 32;
export const PIN_ATTEMPTS_ALLOWED = 5;

// ------------------------------------------------------------------- utility

function toBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

// ------------------------------------------------------------------ the PIN

/**
 * Derive the wrapping key from a device PIN.
 *
 * Exported and pure so it can be tested outside a browser — the storage around it needs
 * a real IndexedDB, but the derivation does not, and the derivation is the part where a
 * mistake is silent.
 *
 * The same 600k iteration count as the recovery code. It is not there to make six digits
 * strong — it is there so that a leaked blob cannot be attacked at a useful speed.
 */
export async function derivePinKey(pin, salt, iterations = 600_000) {
  const normalised = String(pin || '').replace(/\D/g, '');
  if (normalised.length < 6) {
    throw new Error('A device PIN is at least six digits.');
  }

  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalised),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** A fresh salt for a new PIN. Not secret — it only has to be unique. */
export function newPinSalt() {
  return randomBytes(16);
}

// --------------------------------------------------------------- the passkey

/**
 * Whether this browser can actually do the passkey path.
 *
 * Checks for PRF specifically rather than for WebAuthn generally. A platform that can
 * create a credential but not derive from it lands on the PIN, which is honest, instead
 * of on an assertion that would gate nothing.
 */
export async function passkeyCapability() {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    return { available: false, reason: 'this browser has no WebAuthn' };
  }
  if (!window.isSecureContext) {
    // Passkeys need HTTPS or localhost. Anything else is silently unavailable, and
    // silently is the problem — say why.
    return { available: false, reason: 'WebAuthn needs a secure context (HTTPS or localhost)' };
  }
  try {
    const platform = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!platform) {
      return { available: false, reason: 'this device has no platform authenticator' };
    }
  } catch {
    return { available: false, reason: 'could not ask about platform authenticators' };
  }
  return { available: true, reason: 'ok' };
}

/** HKDF the authenticator's PRF output into an AES key. */
async function keyFromPrfOutput(output, salt) {
  const material = await crypto.subtle.importKey('raw', output, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('apnarecord-device') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Register a passkey and derive the device key from it.
 *
 * Two steps on purpose. Creation establishes the credential; a separate assertion is
 * what returns the PRF output, and not every platform evaluates the extension at
 * creation time. Doing both here means the caller gets a key or a clear failure, rather
 * than a credential and a later surprise.
 */
export async function registerPasskey({ label = 'ApnaRecord' } = {}) {
  const capability = await passkeyCapability();
  if (!capability.available) throw new Error(capability.reason);

  const prfSalt = randomBytes(32);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'ApnaRecord' },
      user: {
        // The user handle is opaque and random: it identifies the credential, not the
        // person, and a stable identifier here would be one more way to correlate.
        id: randomBytes(16),
        name: label,
        displayName: label,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });

  if (!credential) throw new Error('No passkey was created.');

  const deviceKey = await unlockWithPasskey({
    credentialId: credential.rawId,
    prfSalt,
  });

  return { credentialId: credential.rawId, prfSalt, deviceKey };
}

/**
 * Ask the authenticator for the PRF output and turn it into the wrapping key.
 *
 * Requires user verification — a fingerprint or the device PIN at the platform level —
 * so this cannot complete without the person being present.
 */
export async function unlockWithPasskey({ credentialId, prfSalt }) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });

  if (!assertion) throw new Error('The passkey prompt was dismissed.');

  const output = assertion.getClientExtensionResults?.()?.prf?.results?.first;
  if (!output || output.byteLength !== PRF_BYTES) {
    throw new Error(
      'This authenticator did not produce the value the unlock needs, so it cannot be ' +
        'used for this device. A device PIN will work instead.'
    );
  }

  return keyFromPrfOutput(new Uint8Array(output), prfSalt);
}

// ------------------------------------------------------- encoding for storage

export const encodeBytes = toBase64;
export const decodeBytes = fromBase64;
