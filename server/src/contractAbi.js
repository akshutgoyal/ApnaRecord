// The server's view of the contract. Deliberately smaller than the client's:
// the server only ever READS. It has no signer, so it cannot mint, grant or
// revoke — every state change is signed in the user's own wallet.
//
// Matches ../../contracts/ApnaRecord.sol. Note what is absent from the reads:
// there is no `consent` getter any more (the mapping is private, so the accepted
// graph cannot be enumerated in bulk), and no `auditRecord` (the server is not
// an auditor). `canAccess` is the only route to a consent question.
//
// Note also that no event here carries clinical data. `RecordMinted` has no
// patient and no record type; `EmergencyAccessUsed` has no reason. Anything the
// server needs beyond a hash and an ownership edge comes from its own database.

export const ABI = [
  // reads the server performs
  "function ownerOf(uint256 tokenId) view returns (address)",
  // How many records an address owns. The rebind guard turns on this: a wallet holding
  // a soulbound record cannot be moved to a new key, because the record could not
  // follow it.
  "function balanceOf(address owner) view returns (uint256)",
  "function viewRecord(uint256 tokenId) view returns (string)",
  "function canAccess(uint256 tokenId, address viewer) view returns (bool)",
  "function verifyRecord(uint256 tokenId, bytes32 fileHash) view returns (bool)",
  "function locked(uint256 tokenId) view returns (bool)",
  "function didFor(address account) view returns (string)",
  "function nextTokenId() view returns (uint256)",

  // facility + identity. `identities` no longer returns a label — labels are
  // off-chain now, because a label is a name in practice.
  "function identities(address) view returns (uint64 createdAt, bool active, address facility)",
  "function facilities(address) view returns (bool)",
  "function facilityOf(address account) view returns (address)",
  "function facilityPatient(address, address) view returns (bool)",
  "function linkedPatients(address facility) view returns (address[])",

  // roles
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function HOSPITAL_ROLE() view returns (bytes32)",
  "function MANAGER_ROLE() view returns (bytes32)",
  "function AUDITOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",

  // events — the audit trail, read straight from logs. These signatures must match the
  // contract exactly; a mismatch makes `parseLog` throw, and the topic hashes in
  // services/chain.js are derived from these same strings.
  "event IdentityCreated(address indexed account, address indexed facility)",
  "event IdentityDeactivated(address indexed account)",
  "event FacilityCreated(address indexed it)",
  "event PatientLinkRequested(address indexed facility, address indexed patient)",
  "event PatientLinked(address indexed facility, address indexed patient)",
  "event PatientUnlinked(address indexed facility, address indexed patient)",
  "event RecordRequested(uint256 indexed requestId, address indexed requester)",
  "event RecordMinted(uint256 indexed tokenId, bytes32 recordHash)",
  "event RecordRevoked(uint256 indexed tokenId, address indexed admin)",
  "event AccessGranted(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt)",
  "event AccessRevoked(uint256 indexed tokenId, address indexed viewer)",
  "event EmergencyAccessUsed(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt)",

  // AccessControl's own events. The audit trail is meant to carry these -- the
  // walkthrough copy calls role grants one of "the nine events" -- but neither
  // this ABI nor the event filter ever listed them, so every grant made through
  // the console was invisible on the audit trail it was made from.
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",

  // custom errors — without these, a revert decodes to nothing useful and every
  // failure looks like "execution reverted (unknown custom error)".
  "error NotAuthorized()",
  "error AccessDenied()",
  "error Expired()",
  "error RecordNotFound()",
  "error IdentityExists()",
  "error IdentityNotFound()",
  "error NotAFacility()",
  "error PatientNotLinked()",
  "error LinkNotRequested()",
  "error OnlyThePatient()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error ERC721NonexistentToken(uint256 tokenId)",
];
