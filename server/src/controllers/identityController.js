// EMAIL VERIFICATION.
//
// Two ideas worth stating before the code.
//
// 1. Per-contact limits stop someone hammering one person's inbox. They do nothing about
//    someone cycling through thousands of addresses, so there is a per-IP limit too, and
//    the hourly cap on each contact is low on purpose. Neither is sufficient alone, and a
//    real deployment should put a WAF in front — mail bombing is a billing and reputation
//    attack rather than a cryptographic one.
//
// 2. A verified address yields a grant that can locate a sealed blob. It cannot open one.
//    That separation is the whole reason an email account being compromised is not a
//    medical-records breach, and it is why the verify endpoint returns a token rather
//    than a session.

import { requestCode, verifyCode } from '../services/otp.js';
import { emailProviderName, isMockProvider } from '../services/emailSender.js';
import { isDbReady } from '../models/index.js';

const WINDOW_MS = 60 * 60 * 1000;
// Configurable so a test suite can exercise the flow repeatedly from one address.
// Production should leave the default.
const MAX_PER_IP = Number(process.env.CONTACT_MAX_PER_IP) || 12;
const ipHits = new Map();

function noteIp(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((at) => now - at < WINDOW_MS);
  if (hits.length >= MAX_PER_IP) return false;
  hits.push(now);
  ipHits.set(ip, hits);
  // Cheap eviction, so the map cannot grow without bound on a long-running process.
  if (ipHits.size > 5000) {
    for (const [key, value] of ipHits) {
      if (!value.some((at) => now - at < WINDOW_MS)) ipHits.delete(key);
    }
  }
  return true;
}

function requireDb(res) {
  if (!isDbReady()) {
    res.status(503).json({
      error: 'DatabaseUnavailable',
      message:
        'Verifying an email address needs the database, because codes and grants are stored ' +
        'there. Everything already on-chain still works without it.',
    });
    return true;
  }
  return false;
}

function fail(res, error) {
  const status =
    error.code === 'TooManyRequests'
      ? 429
      : error.code === 'DatabaseUnavailable'
        ? 503
        : ['CodeInvalid', 'CodeExpired', 'CodeLocked'].includes(error.code)
          ? 400
          : 400;
  return res.status(status).json({ error: error.code || 'ContactError', message: error.message });
}

/** POST /api/identity/email/request  { email } */
export async function sendCode(req, res) {
  if (requireDb(res)) return;

  if (!noteIp(req.ip)) {
    return res.status(429).json({
      error: 'TooManyRequests',
      message: 'Too many codes requested from this address. Try again later.',
    });
  }

  try {
    const result = await requestCode(req.body?.email, 'enrol');
    return res.json({
      ok: true,
      ...result,
      provider: emailProviderName(),
      note: isMockProvider()
        ? 'The mock sender is active: no email was sent, and the code is in the server log.'
        : undefined,
    });
  } catch (error) {
    return fail(res, error);
  }
}

/** POST /api/identity/email/verify  { email, code } → a single-use grant */
export async function checkCode(req, res) {
  if (requireDb(res)) return;
  try {
    const result = await verifyCode(req.body?.email, req.body?.code, 'enrol');
    return res.json({
      ok: true,
      ...result,
      note:
        'This grant can locate your wallet. It cannot open it — that still needs your ' +
        'recovery code.',
    });
  } catch (error) {
    return fail(res, error);
  }
}
