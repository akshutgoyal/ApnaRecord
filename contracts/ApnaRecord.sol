// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
 * PRIVACY — WHAT IS AND IS NOT ON THIS CHAIN
 *
 *   Public, permanently: that a token exists, its 32-byte digest, the address
 *   that owns it, which addresses were granted access and until when, and that
 *   identities and facilities exist.
 *
 *   Never on-chain: the record type, any identity label, any facility name, the
 *   request ledger's contents, the file, the key, the CID's meaning.
 *
 *   Read that as one sentence — `an unknown address holds seven tokens` — not
 *   `Patient 101 has an MRI scan that Dr X may read until Thursday`.
 *
 *   Note what this contract CANNOT do: it cannot gate a read. A `view` function
 *   checking `msg.sender` can be called by anyone, because `eth_call` lets the
 *   caller choose `from` freely. So a "private" mapping behind a gated getter is
 *   not private. Privacy comes from data not being here — which is why metadata
 *   lives in the server's database and only hashes and ownership live here.
 *   Content is safe regardless: the file is AES-GCM encrypted and the server
 *   gates the bytes behind a signed read proof, so learning a CID achieves
 *   nothing.
 *
 * Roles
 *   DEFAULT_ADMIN_ROLE  platform  facilities, any identity, any role, any mint
 *   HOSPITAL_ROLE       hospital IT  its own staff, its own linked patients
 *   MANAGER_ROLE        doctor / lab  requests records, emergency break-glass
 *   AUDITOR_ROLE        auditor   metadata-only audit view, never the file
 *   (record owner)      patient   grants and revokes access to their own record
 *
 * THE PATIENT IS AN ACCOUNT, NOT A KEY
 *   Records are owned by the patient's account contract (ApnaRecordAccount), so
 *   every patient reference here — linking, minting, ownership — is that account
 *   address. The patient's signing key reaches these functions through
 *   `account.execute(...)`, which is what makes `msg.sender` the account.
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
    bytes32 public constant HOSPITAL_ROLE = keccak256("HOSPITAL_ROLE");
    bytes32 public constant MANAGER_ROLE  = keccak256("MANAGER_ROLE");
    bytes32 public constant AUDITOR_ROLE  = keccak256("AUDITOR_ROLE");

    // ------------------------------------------------------------ errors
    error NotAuthorized();
    error AccessDenied();
    error Expired();
    error RecordNotFound();
    error IdentityExists();
    error IdentityNotFound();
    error NotAFacility();
    error PatientNotLinked();
    error LinkNotRequested();
    error OnlyThePatient();

    // ------------------------------------------------------------ events
    //
    // Every one of these is world-readable for ever. Nothing clinical goes in.
    // Compare with the shape of the previous deployment, where `RecordMinted`
    // carried the record type and `EmergencyAccessUsed` carried a clinician's
    // free-text reason — an unbounded channel for clinical detail onto a
    // permanent public log.

    event IdentityCreated(address indexed account, address indexed facility);
    event IdentityDeactivated(address indexed account);

    event FacilityCreated(address indexed it);

    event PatientLinkRequested(address indexed facility, address indexed patient);
    event PatientLinked(address indexed facility, address indexed patient);
    event PatientUnlinked(address indexed facility, address indexed patient);

    /// @dev The request's patient and record type are deliberately absent; they
    ///      live in the server's database. This anchors only that a request was
    ///      made and by whom.
    event RecordRequested(uint256 indexed requestId, address indexed requester);

    /// @dev The patient address is absent (ownership is public via ownerOf and
    ///      carries no more), and so is the record type.
    event RecordMinted(uint256 indexed tokenId, bytes32 recordHash);
    event RecordRevoked(uint256 indexed tokenId, address indexed admin);

    event AccessGranted(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt);
    event AccessRevoked(uint256 indexed tokenId, address indexed viewer);

    /// @dev The reason is gone. It was free text written by a clinician.
    event EmergencyAccessUsed(uint256 indexed tokenId, address indexed viewer, uint64 expiresAt);

    // ------------------------------------------------------------- types
    struct Identity {
        uint64  createdAt;
        bool    active;
        address facility;    // address(0) for platform-level identities
    }

    struct Record {
        bytes32 recordHash;  // keccak256 of the encrypted file held off-chain
        string  cid;         // released only through viewRecord
        uint64  mintedAt;
    }

    // ------------------------------------------------------------- state
    uint256 public nextTokenId   = 1;
    uint256 public nextRequestId = 1;

    mapping(address => Identity) public identities;

    /// @notice A facility IS its Hospital IT wallet. Registering the wallet
    ///         registers the hospital; the name lives off-chain.
    mapping(address => bool) public facilities;

    /// @notice facility => patient => currently linked.
    ///         This is the whole read scope for a hospital, and clearing it is
    ///         what discharge does — one flag, and every record that patient
    ///         holds becomes invisible to that hospital at once, including ones
    ///         the hospital minted itself.
    mapping(address => mapping(address => bool)) public facilityPatient;

    /// @notice facility => patient => asked, not yet consented.
    mapping(address => mapping(address => bool)) public pendingLink;

    mapping(uint256 => Record) private records;

    /// @dev Private on purpose. A public mapping would let anyone enumerate the
    ///      accepted consent graph in bulk. `canAccess` remains the only route,
    ///      and the grant/revoke events still describe individual edges.
    mapping(uint256 => mapping(address => uint64)) private consent;

    // per-facility enumeration, 1-based so 0 means "absent"
    mapping(address => address[]) private _linkedPatients;
    mapping(address => mapping(address => uint256)) private _linkedIndex;

    constructor() ERC721("ApnaRecord Record", "APR") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ----------------------------------------------------------- facility
    /// @notice Register a hospital. The wallet becomes the facility identifier,
    ///         and the platform grants it HOSPITAL_ROLE separately.
    function createFacility(address it) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (it == address(0)) revert NotAFacility();
        facilities[it] = true;
        emit FacilityCreated(it);
    }

    // ----------------------------------------------------------- identity
    /// @notice Register an identity.
    ///         The platform may place anyone anywhere. A hospital may register
    ///         its own staff, and may register the patients it treats — and
    ///         those are different things, so the facility is NOT forced.
    ///
    ///         A patient is a global identity with no facility; a doctor is
    ///         staff and has one. Forcing the caller's own facility here would
    ///         have filed every patient as hospital staff, which is exactly the
    ///         kind of thing that looks fine until you read the row back.
    function createIdentity(address account, address facility) external {
        if (identities[account].active) revert IdentityExists();

        if (hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (facility != address(0) && !facilities[facility]) revert NotAFacility();
        } else if (facilities[msg.sender]) {
            // Own facility for staff, address(0) for a patient. Anything else is
            // a hospital trying to write into another hospital's roster.
            if (facility != address(0) && facility != msg.sender) revert NotAuthorized();
        } else {
            revert NotAuthorized();
        }

        identities[account] = Identity(uint64(block.timestamp), true, facility);
        emit IdentityCreated(account, facility);
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

    /// @notice Which facility an account is staff of, if any.
    function facilityOf(address account) external view returns (address) {
        return identities[account].facility;
    }

    // ----------------------------------------------------- patient links
    /// @notice A hospital asks to treat a patient. This grants nothing.
    function requestPatientLink(address patient) external onlyRole(HOSPITAL_ROLE) {
        if (!identities[patient].active) revert IdentityNotFound();
        pendingLink[msg.sender][patient] = true;
        emit PatientLinkRequested(msg.sender, patient);
    }

    /// @notice The patient consents. Called BY the patient — their account, via
    ///         its owner key — which is the whole point: a hospital cannot link
    ///         someone unilaterally and thereby read their history.
    function approvePatientLink(address facility) external {
        if (!pendingLink[facility][msg.sender]) revert LinkNotRequested();
        pendingLink[facility][msg.sender] = false;
        facilityPatient[facility][msg.sender] = true;
        _addLinked(facility, msg.sender);
        emit PatientLinked(facility, msg.sender);
    }

    /// @notice The patient withdraws consent unilaterally, at any time.
    function revokePatientLink(address facility) external {
        if (!facilityPatient[facility][msg.sender]) revert PatientNotLinked();
        _endLink(facility, msg.sender);
    }

    /// @notice Discharge. The patient leaves, and the hospital loses sight of
    ///         every record that patient holds — including ones it minted. It
    ///         keeps the public event log, which nobody can take away.
    function dischargePatient(address patient) external onlyRole(HOSPITAL_ROLE) {
        if (!facilityPatient[msg.sender][patient]) revert PatientNotLinked();
        _endLink(msg.sender, patient);
    }

    function _endLink(address facility, address patient) private {
        facilityPatient[facility][patient] = false;
        pendingLink[facility][patient] = false;
        _removeLinked(facility, patient);
        emit PatientUnlinked(facility, patient);
    }

    function _addLinked(address facility, address patient) private {
        if (_linkedIndex[facility][patient] != 0) return;
        _linkedPatients[facility].push(patient);
        _linkedIndex[facility][patient] = _linkedPatients[facility].length;
    }

    /// @dev Swap-and-pop. Order is not meaningful to any caller.
    function _removeLinked(address facility, address patient) private {
        uint256 idx = _linkedIndex[facility][patient];
        if (idx == 0) return;

        uint256 last = _linkedPatients[facility].length;
        if (idx != last) {
            address moved = _linkedPatients[facility][last - 1];
            _linkedPatients[facility][idx - 1] = moved;
            _linkedIndex[facility][moved] = idx;
        }
        _linkedPatients[facility].pop();
        delete _linkedIndex[facility][patient];
    }

    /// @notice The patients a hospital currently holds. Needed because the
    ///         contract has no enumeration of its own, and the hospital console
    ///         has to list something.
    function linkedPatients(address facility) external view returns (address[] memory) {
        return _linkedPatients[facility];
    }

    // ----------------------------------------------------------- manager
    /// @notice A clinician requests that a record be issued. Requesting is not
    ///         minting: the issuer decides.
    ///
    ///         Note what is NOT here. The subject of the request is not a
    ///         parameter, because naming the patient on-chain would publish the
    ///         doctor-to-patient edge — which is more than ownership already
    ///         reveals, since it says who is interested in whom. The patient and
    ///         the record type live in the server's database, and this call
    ///         anchors only that a request was made and by whom.
    ///
    ///         The trade: the ledger's CONTENTS become trust-the-server, while
    ///         the fact that a request happened stays verifiable. That is the
    ///         intended split, not an oversight.
    function requestRecord()
        external
        onlyRole(MANAGER_ROLE)
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;
        emit RecordRequested(requestId, msg.sender);
    }

    /// @notice Break-glass: one record, one hour.
    ///         The clinician's justification is recorded in the server's
    ///         database rather than on a permanent public log.
    function emergencyAccess(uint256 tokenId, address viewer)
        external
        onlyRole(MANAGER_ROLE)
    {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        uint64 expiry = uint64(block.timestamp) + 1 hours;
        consent[tokenId][viewer] = expiry;
        emit EmergencyAccessUsed(tokenId, viewer, expiry);
    }

    // ------------------------------------------------------------- issuing
    /// @notice Issue a record to a patient. The record is soulbound from birth.
    ///
    ///         The platform may issue anywhere. A hospital may issue only for a
    ///         patient who is currently linked to it — which is the ONE thing
    ///         this contract can genuinely enforce, because it gates a write.
    ///         Metadata scoping for reads is the server's job, since a read
    ///         cannot be gated here at all.
    function mintRecord(address patient, bytes32 recordHash, string calldata cid)
        external
        returns (uint256 tokenId)
    {
        if (!identities[patient].active) revert IdentityNotFound();

        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (!facilities[msg.sender]) revert NotAFacility();
            if (!facilityPatient[msg.sender][patient]) revert PatientNotLinked();
        }

        tokenId = nextTokenId++;
        records[tokenId] = Record(recordHash, cid, uint64(block.timestamp));

        // `_mint`, deliberately, NOT `_safeMint`.
        //
        // The patient is the account contract, and `_safeMint` reverts when the
        // receiver is a contract that does not implement `onERC721Received` —
        // which ApnaRecordAccount does not, and has no reason to. Using
        // `_safeMint` would have failed every mint to a real patient, and it
        // would have failed at the last step of the flow, after the bytes were
        // already stored.
        //
        // `_safeMint` exists to stop tokens being sent somewhere they cannot be
        // recovered from. That risk does not apply here: a record is soulbound
        // and can never move, so there is nothing to recover it from.
        _mint(patient, tokenId);

        emit RecordMinted(tokenId, recordHash);
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

    /// @notice Auditor-only metadata. Never the CID, never the file, and no
    ///         longer the record type — that is off-chain like all the rest.
    function auditRecord(uint256 tokenId)
        external
        view
        onlyRole(AUDITOR_ROLE)
        returns (bytes32 recordHash, uint64 mintedAt, address owner)
    {
        if (_ownerOf(tokenId) == address(0)) revert RecordNotFound();
        Record storage r = records[tokenId];
        return (r.recordHash, r.mintedAt, ownerOf(tokenId));
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
