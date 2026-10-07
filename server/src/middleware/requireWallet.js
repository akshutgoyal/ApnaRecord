import { ethers } from 'ethers';
import { verifyReadProof } from '../lib/readProof.js';
import { call, permissions } from '../services/chain.js';
import { isDbReady, SessionModel } from '../models/index.js';

/**
 * Who is asking, for reads that return off-chain data.
 *
 * The chain reads need no gate — a block explorer is the same thing. What is NOT public
 * is everything the chain deliberately refuses to carry: file names, MIME types, facility
 * names, the record index, and above all the clinical profile.
 *
 * Two ways to answer, and both end at the same place:
 *
 *   - a raw EIP-712 read proof in headers. Correct, and single-use, because the nonce is
 *     spent against a unique index. One proof, one request.
 *   - a bearer token from POST /auth/session, which was itself bought with one such
 *     proof. Reusable until it expires.
 *
 * The second exists because the first would prompt MetaMask on every page load, and a
 * prompt people learn to dismiss is not a control. The token carries no claims — the
 * viewer is a row, and entitlement is still decided against the chain per request.
 */
async function viewerFromToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !isDbReady()) return null;

  const row = await SessionModel.findOne({ token: match[1] }).lean();
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return null;

  return ethers.getAddress(row.viewer);
}

export async function requireWallet(req, res, next) {
  try {
    const viaToken = await viewerFromToken(req);
    if (viaToken) {
      req.viewer = viaToken;
      return next();
    }
  } catch {
    // A database blip must not read as "you are not who you say". Fall through to the
    // proof path, which does not need the database to establish identity.
  }

  const viewer = req.get('x-apnarecord-viewer');

  if (!viewer || !ethers.isAddress(viewer)) {
    return res.status(401).json({
      error: 'ProofRequired',
      message:
        'This endpoint returns off-chain data, so the caller must prove they hold a wallet. ' +
        'Either send a bearer token from POST /auth/session, or sign the message below directly.',
      howToSign:
        'x-apnarecord-viewer, x-apnarecord-issued-at, x-apnarecord-nonce, x-apnarecord-signature',
      tokenEndpoint: '/api/auth/session',
    });
  }

  const refused = await verifyReadProof({
    tokenId: 0,
    viewer,
    issuedAt: req.get('x-apnarecord-issued-at'),
    nonce: req.get('x-apnarecord-nonce'),
    signature: req.get('x-apnarecord-signature'),
  });

  if (refused) {
    return res.status(401).json({ error: 'ProofRequired', message: refused, viewer });
  }

  req.viewer = ethers.getAddress(viewer);
  return next();
}

/**
 * May this viewer see this subject's off-chain data?
 *
 * Three ways to qualify and no fourth: they ARE the subject; they hold a role that reads
 * across the platform; or they are a facility the subject is linked to. The third is what
 * lets a hospital see the patient it treats without also seeing every other patient.
 */
export async function mayReadSubject(viewer, subject) {
  const a = String(viewer).toLowerCase();
  const b = String(subject).toLowerCase();
  if (a === b) return true;

  const ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const [isAdmin, held] = await Promise.all([
    call('hasRole', [ADMIN_ROLE, viewer]).then((r) => Boolean(r?.[0])).catch(() => false),
    permissions(viewer).catch(() => null),
  ]);

  if (isAdmin) return true;

  // Auditors can inspect metadata platform-wide, matching the scope used by
  // entitledPatients() and the AUDITOR_ROLE contract gate.
  if (held?.roles?.auditor) return true;

  if (held?.isFacility && held.roles?.hospital) {
    const linked = await call('facilityPatient', [viewer, subject]).catch(() => null);
    if (linked?.[0]) return true;
  }

  return false;
}

/**
 * The same check, for routes whose subject is in the path.
 *
 * Composed as middleware rather than repeated in six controllers, which is how five of
 * them end up slightly different.
 */
export function requireSubject(param = 'address') {
  return async function subjectGuard(req, res, next) {
    const subject = req.params[param];
    if (!subject || !ethers.isAddress(subject)) {
      return res.status(400).json({ error: 'BadRequest', message: `Not a valid ${param}.` });
    }
    try {
      if (await mayReadSubject(req.viewer, subject)) return next();
    } catch {
      // A chain read failed, so entitlement is unknown. Refusing is both the safe answer
      // and the true one: we cannot say this viewer is entitled.
      return res.status(503).json({
        error: 'ChainUnavailable',
        message: 'Could not check your entitlement against the contract. Try again shortly.',
      });
    }
    return res.status(403).json({
      error: 'NotYourData',
      message:
        `You are ${req.viewer}. This data belongs to ${subject}, and your wallet is neither that ` +
        'address, nor a facility linked to it, nor an administrator. Off-chain records are not ' +
        'public — ask the owner, or read the on-chain metadata instead.',
      viewer: req.viewer,
      subject,
    });
  };
}

/**
 * Which patients' off-chain rows may this viewer see?
 *
 * `null` means all of them — an administrator or an auditor reads across the platform,
 * which is the point of those roles. Everyone else gets a Set: themselves, plus the
 * patients of a facility they act for. A Set rather than a filter callback because both
 * list endpoints need the same answer, and asking the chain once per row would turn one
 * page load into N calls.
 */
export async function entitledPatients(viewer) {
  const ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';

  const [isAdmin, auditorRole, held] = await Promise.all([
    call('hasRole', [ADMIN_ROLE, viewer]).then((r) => Boolean(r?.[0])).catch(() => false),
    call('AUDITOR_ROLE').then((r) => r?.[0]).catch(() => null),
    permissions(viewer).catch(() => null),
  ]);

  if (isAdmin) return null;

  if (auditorRole) {
    const isAuditor = await call('hasRole', [auditorRole, viewer])
      .then((r) => Boolean(r?.[0]))
      .catch(() => false);
    if (isAuditor) return null;
  }

  const entitled = new Set([String(viewer).toLowerCase()]);

  if (held?.isFacility && held.roles?.hospital) {
    // Authorization follows the current contract state. The MongoDB link mirror
    // is an index and can lag a discharge, so it must not decide whether clinical
    // metadata is disclosed.
    const [linked] = await call('linkedPatients', [viewer]);
    for (const patient of linked || []) entitled.add(String(patient).toLowerCase());
  }

  return entitled;
}

/**
 * Establish the viewer IF one is offered, and carry on either way.
 *
 * For the two endpoints that must keep serving an anonymous caller: `/records`, because
 * the public verification primitive needs to enumerate tokens to check a digest against,
 * and the audit trail.
 *
 * The caller who offers nothing gets the ON-CHAIN fields only — token id, digest,
 * owner, block. Those are public by construction; a block explorer shows the same. What
 * they do not get is the off-chain half: file names, MIME types, record types. That is
 * the line this draws, and it is the project's own thesis rather than a new rule.
 */
export async function optionalWallet(req, res, next) {
  try {
    const viaToken = await viewerFromToken(req);
    if (viaToken) {
      req.viewer = viaToken;
      return next();
    }
    const viewer = req.get('x-apnarecord-viewer');
    if (viewer && ethers.isAddress(viewer)) {
      const refused = await verifyReadProof({
        tokenId: 0,
        viewer,
        issuedAt: req.get('x-apnarecord-issued-at'),
        nonce: req.get('x-apnarecord-nonce'),
        signature: req.get('x-apnarecord-signature'),
      });
      if (!refused) req.viewer = ethers.getAddress(viewer);
    }
  } catch {
    // No viewer then. The on-chain subset is still served.
  }
  return next();
}

/**
 * The label map, filtered to what this viewer may see.
 *
 * Labels are the one off-chain thing the dashboard aggregates carry — a count of
 * "three doctors" is public, "Dr Meera at City Hospital" is not. The walkthrough is
 * supposed to show live chain data without a wallet, so the numbers have to stay
 * readable anonymously; only the names are withheld.
 *
 * Admin and auditor read the whole directory. Everyone else gets the names they are
 * already entitled to — their own, and a facility's linked patients — which is the
 * same rule the record list uses.
 */
export async function visibleLabels(viewer) {
  const { labelMap } = await import('../services/chain.js');
  if (!viewer) return {};
  const all = await labelMap().catch(() => ({}));
  const entitled = await entitledPatients(viewer).catch(() => new Set());
  if (!entitled) return all;
  const out = {};
  for (const [address, label] of Object.entries(all)) {
    if (entitled.has(String(address).toLowerCase())) out[address] = label;
  }
  return out;
}
