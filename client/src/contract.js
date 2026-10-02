// The client's view of the contract. Matches ../../contracts/ApnaRecord.sol,
// which is the source for the instance deployed on Sepolia.
//
// The custom errors are not decoration: without them ethers can only say
// "execution reverted (unknown custom error)", which is what makes a
// wrong-wallet mistake look like a broken contract.

export const ABI = [
  // facility
  'function createFacility(address it)',
  'function facilities(address) view returns (bool)',
  'function facilityOf(address account) view returns (address)',

  // identity
  'function createIdentity(address account, address facility)',
  'function deactivateIdentity(address account)',
  'function didFor(address account) view returns (string)',
  'function identities(address) view returns (uint64 createdAt, bool active, address facility)',

  // patient links — the consent handshake
  'function requestPatientLink(address patient)',
  'function approvePatientLink(address facility)',
  'function revokePatientLink(address facility)',
  'function dischargePatient(address patient)',
  'function facilityPatient(address, address) view returns (bool)',
  'function pendingLink(address, address) view returns (bool)',
  'function linkedPatients(address facility) view returns (address[])',

  // manager
  'function requestRecord() returns (uint256)',
  'function emergencyAccess(uint256 tokenId, address viewer)',

  // issuing
  'function mintRecord(address patient, bytes32 recordHash, string cid) returns (uint256)',
  'function revokeRecord(uint256 tokenId)',

  // patient / owner
  'function grantAccess(uint256 tokenId, address viewer, uint64 durationSeconds)',
  'function revokeAccess(uint256 tokenId, address viewer)',

  // reads
  'function canAccess(uint256 tokenId, address viewer) view returns (bool)',
  'function viewRecord(uint256 tokenId) view returns (string)',
  'function verifyRecord(uint256 tokenId, bytes32 fileHash) view returns (bool)',
  'function auditRecord(uint256 tokenId) view returns (bytes32 recordHash, uint64 mintedAt, address owner)',
  'function locked(uint256 tokenId) view returns (bool)',
  'function nextTokenId() view returns (uint256)',
  'function nextRequestId() view returns (uint256)',

  // erc721 surface the UI touches
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 tokenId)',

  // access control
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account)',
  'function HOSPITAL_ROLE() view returns (bytes32)',
  'function MANAGER_ROLE() view returns (bytes32)',
  'function AUDITOR_ROLE() view returns (bytes32)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',

  // events — none of these carry clinical data any more. The record type, the
  // identity label, the facility name and the break-glass reason all moved
  // off-chain; the patient is omitted from RecordMinted because `ownerOf`
  // already says it and says no more.
  'event IdentityCreated(address indexed account, address indexed facility)',
  'event IdentityDeactivated(address indexed account)',
  'event FacilityCreated(address indexed it)',
  'event PatientLinkRequested(address indexed facility, address indexed patient)',
  'event PatientLinked(address indexed facility, address indexed patient)',
  'event PatientUnlinked(address indexed facility, address indexed patient)',
  'event RecordRequested(uint256 indexed requestId, address indexed requester)',
  'event RecordMinted(uint256 indexed tokenId, bytes32 recordHash)',
  'event RecordRevoked(uint256 indexed tokenId, address indexed admin)',
  'event AccessGranted(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt)',
  'event AccessRevoked(uint256 indexed tokenId, address indexed viewer)',
  'event EmergencyAccessUsed(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt)',
  'event Locked(uint256 tokenId)',
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',

  // custom errors
  'error NotAuthorized()',
  'error AccessDenied()',
  'error Expired()',
  'error RecordNotFound()',
  'error IdentityExists()',
  'error IdentityNotFound()',
  'error NotAFacility()',
  'error PatientNotLinked()',
  'error LinkNotRequested()',
  'error OnlyThePatient()',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error ERC721InvalidReceiver(address receiver)',
  'error ReentrancyGuardReentrantCall()',
];

/**
 * The account that owns the records, and can never change hands.
 *
 * Every write goes through `execute`, because `msg.sender` at ApnaRecord has to be the
 * account — the signing key owns nothing, so calling directly reverts. The allowlist is
 * the point of the contract: the key can reach ApnaRecord and nothing else.
 */
export const ACCOUNT_ABI = [
  'function owner() view returns (address)',
  'function isAllowedTarget(address target) view returns (bool)',
  'function execute(address target, uint256 value, bytes data) returns (bytes)',

  // Named so a refusal arrives as something readable rather than "unknown custom error".
  'error NotOwner()',
  'error TargetNotAllowed(address target)',
  'error CallFailed(bytes reason)',
];

// `import.meta.env` exists only under Vite. Optional chaining costs nothing in the
// browser and makes this module importable by plain Node, which is what lets the
// test suite load the real read-proof domain instead of re-declaring it and
// proving only that two copies of the same constant match.
export const CONTRACT_ADDRESS =
  import.meta.env?.VITE_CONTRACT_ADDRESS || '0xB6e5091f352D3d38933997d78a3585666B4EBaD0';

// ---------------------------------------------------------------- the chain
//
// Every chain-specific fact is read from the environment, with Base Sepolia as the
// default. It used to be hardcoded to Sepolia, which meant moving chains touched
// this file and four others — and the two constants that were NOT parameterised
// (the chain name and the explorer) were the ones most likely to be forgotten,
// leaving the UI confidently linking to the wrong block explorer.
//
// Set VITE_CHAIN_ID, VITE_CHAIN_NAME, VITE_EXPLORER and VITE_TX_EXPLORER together.
// Nothing else in the client needs to know which chain this is.
export const CHAIN_ID = Number(import.meta.env?.VITE_CHAIN_ID || 84532);

export const CHAIN_NAME = import.meta.env?.VITE_CHAIN_NAME || 'Base Sepolia';

/** Base for address links. The contract address is appended. */
const EXPLORER_BASE =
  import.meta.env?.VITE_EXPLORER || 'https://sepolia.basescan.org/address/';

/** Base for transaction links. The tx hash is appended. */
export const TX_EXPLORER = import.meta.env?.VITE_TX_EXPLORER || 'https://sepolia.basescan.org/tx/';

export const EXPLORER = `${EXPLORER_BASE}${CONTRACT_ADDRESS}`;

export const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:5000/api';

/** The four roles, and what each one may actually do. */
export const ROLES = {
  admin: {
    key: 'admin',
    label: 'Admin',
    subtitle: 'Platform',
    path: '/admin',
    can: 'Create facilities · register identities · mint records · revoke records · grant roles',
    cannot: 'Read a patient file without consent',
  },
  doctor: {
    key: 'doctor',
    label: 'Doctor',
    subtitle: 'Manager role',
    path: '/doctor',
    can: 'Request records · read with consent · emergency break-glass (logged)',
    cannot: 'Mint records · keep access after a window closes',
  },
  hospital: {
    key: 'hospital',
    label: 'Hospital',
    subtitle: 'Hospital IT',
    path: '/hospital',
    can: 'Link patients with consent · mint for linked patients · manage own staff',
    cannot: 'Read a patient file · see patients from other hospitals',
  },
  auditor: {
    key: 'auditor',
    label: 'Auditor',
    subtitle: 'Auditor role',
    path: '/auditor',
    can: 'Read hash, type, time and owner · read the full event log',
    cannot: 'Ever receive the file location',
  },
  patient: {
    key: 'patient',
    label: 'Patient',
    subtitle: 'Record owner',
    path: '/patient',
    can: 'Own records · grant time-boxed access · revoke at will',
    cannot: 'Transfer a record to anyone else',
  },
};

export const ROLE_ORDER = ['admin', 'hospital', 'doctor', 'auditor', 'patient'];
