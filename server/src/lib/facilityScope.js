import { ethers } from 'ethers';
import { PatientLinkModel, isDbReady } from '../models/index.js';

// FACILITY READ SCOPE.
//
// A hospital sees only the patients currently linked to it — including, by
// design, nothing after discharge. The chain cannot enforce reads (a `view`
// gated by `msg.sender` answers to anyone who names a `from`), so this scope
// is enforced here, in the one layer that joins metadata to identity.
//
// This is UI scoping, not a cryptographic boundary, and it is documented as
// such: the chain remains the audit trail, and anyone reading logs directly
// sees the same pseudonymous edges. What this stops is a hospital console
// casually rendering another facility's patients.

/**
 * Resolve the patient set for a facility address.
 * Returns lowercase patient addresses with an active link.
 * Throws { status, error, message } on bad input or a missing database.
 */
export async function linkedPatientsOf(facility) {
  if (!ethers.isAddress(facility)) {
    throw { status: 400, error: 'BadRequest', message: 'Not a valid facility address.' };
  }
  if (!isDbReady()) {
    throw {
      status: 503,
      error: 'DatabaseUnavailable',
      message: 'Scoped reads need the database, because links live there.',
    };
  }
  const rows = await PatientLinkModel.find({
    facility: facility.toLowerCase(),
    state: 'linked',
  }).lean();
  return rows.map((r) => r.patient);
}
