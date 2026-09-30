// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// ERC-5192: Minimal Soulbound NFTs
interface IERC5192 {
    event Locked(uint256 tokenId);
    function locked(uint256 tokenId) external view returns (bool);
}

/**
 * ApnaRecord
 * Patient-owned medical records as soulbound NFTs, with access that only the
 * record's owner can open and that the contract closes on time.
 *
 * This is the canonical source for the contract deployed on Sepolia at
 * 0x464e6963cE0D833193C83Fc8Bd081614B9344b03. The client's ABI must stay in
 * step with the function signatures below. Renaming the contract or its ERC-721
 * label does not change that ABI, so the deployed instance remains compatible.
 *
 * Roles
 *   DEFAULT_ADMIN_ROLE  hospital IT  register identities, mint, revoke, grant roles
 *   MANAGER_ROLE        doctor / lab requests records, emergency break-glass
 *   AUDITOR_ROLE        auditor      metadata-only audit view, never the file
 *   (record owner)      patient      grants and revokes access to their own record
 *
 * Identity : did:ethr:<chainid>:<account>, derived from the key rather than
 *            looked up, so there is nothing to register before you can prove
 *            who you are. Registration on-chain is an auditable act, not a
 *            prerequisite for the identifier to exist.
 * On-chain : the 32-byte digest is the truth anchor. The CID is released only
 *            through viewRecord, to the owner or a consented viewer.
 *
 * COMPILER NOTE — set the EVM version to CANCUN.
 *   Remix: Compile tab -> Advanced Configurations -> EVM Version -> cancun.
 *   Solidity 0.8.24 defaults to the older 'shanghai' target, while current
 *   OpenZeppelin releases use the `mcopy` instruction, which exists only from
 *   Cancun onwards. Without this you get a DeclarationError naming `mcopy`,
 *   pointing into Bytes.sol inside OpenZeppelin. The contract is fine; the
 *   compiler setting is what is wrong.
 */
contract ApnaRecord is ERC721, AccessControl, ReentrancyGuard, IERC5192 {

    // ------------------------------------------------------------- roles
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    // ------------------------------------------------------------ errors
    error NotAuthorized();
    error AccessDenied();
    error Expired();
    error RecordNotFound();
    error IdentityExists();
    error IdentityNotFound();

    // ------------------------------------------------------------ events
    event IdentityCreated(address indexed account, string label);
    event IdentityDeactivated(address indexed account);

    event RecordRequested(uint256 indexed requestId, address indexed requester,
                          address indexed patient, string recordType);
    event RecordMinted(uint256 indexed tokenId, address indexed patient,
                       bytes32 recordHash, string recordType);
    event RecordRevoked(uint256 indexed tokenId, address indexed admin);

    event AccessGranted(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt);
    event AccessRevoked(uint256 indexed tokenId, address indexed viewer);
    event EmergencyAccessUsed(uint256 indexed tokenId, address indexed viewer,
                              string reason, uint64 expiresAt);

    // ------------------------------------------------------------- types
    struct Identity {
        string label;        // a role title, never personal data
        uint64 createdAt;
        bool   active;
    }

    struct Record {
        bytes32 recordHash;  // keccak256 of the encrypted file held off-chain
        string  cid;         // released only through viewRecord
        string  recordType;  // e.g. "MRI_SCAN"
        uint64  mintedAt;
    }

    // ------------------------------------------------------------- state
    uint256 public nextTokenId   = 1;
    uint256 public nextRequestId = 1;

    mapping(address => Identity) public identities;
    mapping(uint256 => Record)   private records;
    // consent[tokenId][viewer] = expiry timestamp (0 means no access)
    mapping(uint256 => mapping(address => uint64)) public consent;

    constructor() ERC721("ApnaRecord Record", "APR") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ---------------------------------------------------------- identity
    /// @notice Register an identity. The DID is derived from the key as
    ///         did:ethr:<chainid>:<account>, so no registry is needed to
    ///         resolve it — this call exists to make the act auditable.
    function createIdentity(address account, string calldata label)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (identities[account].active) revert IdentityExists();
        identities[account] = Identity(label, uint64(block.timestamp), true);
        emit IdentityCreated(account, label);
    }

    /// @notice Retire an identity. History is retained; only the status changes.
    function deactivateIdentity(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!identities[account].active) revert IdentityNotFound();
        identities[account].active = false;
        emit IdentityDeactivated(account);
    }

    /// @notice The decentralized identifier for an account, as a derived string.
    function didFor(address account) external view returns (string memory) {
        return string.concat("did:ethr:", _uintToStr(block.chainid), ":", _addrToHex(account));
    }

    // ----------------------------------------------------------- manager
    /// @notice A clinician requests that a record be issued for a patient.
    ///         Requesting is not minting: the admin decides.
    function requestRecord(address patient, string calldata recordType)
        external
        onlyRole(MANAGER_ROLE)
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;
        emit RecordRequested(requestId, msg.sender, patient, recordType);
    }

    /// @notice Break-glass: one record, one hour, reason recorded permanently.
    function emergencyAccess(uint256 tokenId, address viewer, string calldata reason)
        external
        onlyRole(MANAGER_ROLE)
    {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        uint64 expiry = uint64(block.timestamp) + 1 hours;
        consent[tokenId][viewer] = expiry;
        emit EmergencyAccessUsed(tokenId, viewer, reason, expiry);
    }

    // ------------------------------------------------------------- admin
    /// @notice Only the administrator may mint. The record is allocated to a
    ///         registered identity and is soulbound from birth.
    function mintRecord(address patient, bytes32 recordHash,
                        string calldata cid, string calldata recordType)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint256 tokenId)
    {
        if (!identities[patient].active) revert IdentityNotFound();
        tokenId = nextTokenId++;
        records[tokenId] = Record(recordHash, cid, recordType, uint64(block.timestamp));
        _safeMint(patient, tokenId);
        emit RecordMinted(tokenId, patient, recordHash, recordType);
        emit Locked(tokenId);
    }

    /// @notice Invalidate a record — used when a patient's wallet is lost.
    function revokeRecord(uint256 tokenId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        _burn(tokenId);
        delete records[tokenId];
        emit RecordRevoked(tokenId, msg.sender);
    }

    // ----------------------------------------------------------- patient
    /// @notice The record owner grants time-boxed access. The contract — not
    ///         the interface — is what makes the window expire.
    function grantAccess(uint256 tokenId, address viewer, uint64 durationSeconds) external {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        if (ownerOf(tokenId) != msg.sender) revert NotAuthorized();
        uint64 expiry = uint64(block.timestamp) + durationSeconds;
        consent[tokenId][viewer] = expiry;
        emit AccessGranted(tokenId, viewer, expiry);
    }

    function revokeAccess(uint256 tokenId, address viewer) external {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        if (ownerOf(tokenId) != msg.sender) revert NotAuthorized();
        consent[tokenId][viewer] = 0;
        emit AccessRevoked(tokenId, viewer);
    }

    // ------------------------------------------------------------- reads
    /// @notice Whether `viewer` may currently read `tokenId`.
    function canAccess(uint256 tokenId, address viewer) public view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        uint64 expiry = consent[tokenId][viewer];
        return expiry != 0 && expiry > block.timestamp;
    }

    /// @notice File location for the owner or a consented viewer — reverts otherwise.
    function viewRecord(uint256 tokenId) external view returns (string memory cid) {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        if (ownerOf(tokenId) != msg.sender && !canAccess(tokenId, msg.sender)) {
            if (consent[tokenId][msg.sender] == 0) revert AccessDenied();
            revert Expired();
        }
        return records[tokenId].cid;
    }

    /// @notice Free verification. Returns only a verdict, never the record.
    function verifyRecord(uint256 tokenId, bytes32 fileHash) external view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        return records[tokenId].recordHash == fileHash;
    }

    /// @notice Auditor-only metadata. Never the CID, never the file.
    function auditRecord(uint256 tokenId)
        external
        view
        onlyRole(AUDITOR_ROLE)
        returns (bytes32 recordHash, string memory recordType, uint64 mintedAt, address owner)
    {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        Record storage r = records[tokenId];
        return (r.recordHash, r.recordType, r.mintedAt, ownerOf(tokenId));
    }

    // --------------------------------------------------------- soulbound
    /// @notice ERC-5192: every record in this collection is locked.
    function locked(uint256 tokenId) external view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        return true;
    }

    /// @dev Block transfers; allow minting (from == 0) and burning (to == 0).
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert NotAuthorized();
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return interfaceId == type(IERC5192).interfaceId
            || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------- hex helpers
    function _addrToHex(address a) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes20 data = bytes20(a);
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            out[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            out[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(out);
    }

    function _uintToStr(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) { len++; n /= 10; }
        bytes memory out = new bytes(len);
        while (v != 0) { out[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(out);
    }
}
