// The server's view of the contract. Deliberately smaller than the client's:
// the server only ever READS. It has no signer, so it cannot mint, grant or
// revoke — every state change is signed in the user's own wallet.
//
// Matches ../../contracts/ApnaRecord.sol (deployed on Sepolia).

export const ABI = [
  // reads the server performs
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function viewRecord(uint256 tokenId) view returns (string)",
  "function canAccess(uint256 tokenId, address viewer) view returns (bool)",
  "function consent(uint256, address) view returns (uint64)",
  "function verifyRecord(uint256 tokenId, bytes32 fileHash) view returns (bool)",
  "function locked(uint256 tokenId) view returns (bool)",
  "function didFor(address account) view returns (string)",
  "function identities(address) view returns (string label, uint64 createdAt, bool active)",
  "function nextTokenId() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function MANAGER_ROLE() view returns (bytes32)",
  "function AUDITOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",

  // events — the audit trail, read straight from logs
  "event IdentityCreated(address indexed account, string label)",
  "event IdentityDeactivated(address indexed account)",
  "event RecordRequested(uint256 indexed requestId, address indexed requester, address indexed patient, string recordType)",
  "event RecordMinted(uint256 indexed tokenId, address indexed patient, bytes32 recordHash, string recordType)",
  "event RecordRevoked(uint256 indexed tokenId, address indexed admin)",
  "event AccessGranted(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt)",
  "event AccessRevoked(uint256 indexed tokenId, address indexed viewer)",
  "event EmergencyAccessUsed(uint256 indexed tokenId, address indexed viewer, string reason, uint64 expiresAt)",

  // custom errors — without these, a revert decodes to nothing useful and every
  // failure looks like "execution reverted (unknown custom error)".
  "error NotAuthorized()",
  "error AccessDenied()",
  "error Expired()",
  "error RecordNotFound()",
  "error IdentityExists()",
  "error IdentityNotFound()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error ERC721NonexistentToken(uint256 tokenId)",
];
