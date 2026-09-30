// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ApnaRecordAccount
 *
 * The address that permanently owns a patient's records.
 *
 * WHY THIS EXISTS AT ALL. With a single owner that never changes, an ordinary EOA
 * looks equivalent — the address is stable in both cases. It is not:
 *
 *   An EOA key can sign ANYTHING. Any transaction, any message, any chain. If it
 *   leaks, whoever holds it can drain every asset that address ever touches and
 *   impersonate the user anywhere.
 *
 *   This key can only call `execute`, and only on an allowlisted target. A leaked
 *   key is therefore bounded to calling ApnaRecord — granting access to records,
 *   which is bad, but not "the key is now an unlimited wallet".
 *
 * That bounding is the entire point. Everything else here follows from it.
 *
 * WHAT IS DELIBERATELY ABSENT, because each absence is a decision:
 *
 *   No owner rotation. There is no setter, so the owner is fixed at construction.
 *   That is what makes the address — and the soulbound records bound to it —
 *   permanent. The cost is real and belongs in the open: a leaked owner key can
 *   never be replaced, only abandoned, and abandoning it strands the records.
 *
 *   No recovery, no signer set, no guardians, no timelock. Recovery is the paper
 *   code unwrapping this same key on a new device, entirely client-side. Nothing
 *   about it needs the chain to cooperate.
 *
 *   No proxy, no admin role, no pause, and no SELFDESTRUCT. There is no privileged
 *   key to steal, and the account cannot be removed out from under the records.
 *
 *   No dependencies. Deliberately not OpenZeppelin: `ecrecover` is a dozen lines
 *   and this contract has to be small enough to read in one sitting, since a bug
 *   in it is unrecoverable.
 *
 * The owner is a plain key that signs ordinary transactions. This account is not an
 * ERC-4337 smart account and needs no bundler, no EntryPoint and no paymaster — the
 * gas float already exists, and it pays for the one deployment this ever needs.
 */
contract ApnaRecordAccount {
    /// @notice The key that may call `execute`. Fixed at construction.
    address public immutable owner;

    /// @notice Contracts the owner may call. Nothing else is reachable from here.
    mapping(address => bool) public isAllowedTarget;

    event Executed(address indexed target, uint256 value, bytes data);
    event Received(address indexed from, uint256 amount);

    error NotOwner();
    error TargetNotAllowed(address target);
    error CallFailed(bytes reason);

    /// @param owner_ the signing key. Not a contract, and not the zero address.
    /// @param allowedTargets_ the complete set of callable contracts. Usually just
    ///        ApnaRecord. Immutable, so widening it means a new account — which is
    ///        the honest consequence of a fixed target set, and preferable to an
    ///        allowlist someone can quietly extend later.
    constructor(address owner_, address[] memory allowedTargets_) {
        require(owner_ != address(0), "owner is required");
        owner = owner_;

        for (uint256 i = 0; i < allowedTargets_.length; i++) {
            isAllowedTarget[allowedTargets_[i]] = true;
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * Call an allowlisted contract as this account.
     *
     * This is how the account grants access, revokes it, or performs any other
     * action on a record it owns — `msg.sender` at the target is this account, which
     * is what the record's ownership checks compare against.
     *
     * Reverts with the target's own reason rather than swallowing it, so a refusal
     * from ApnaRecord (`Expired`, `AccessDenied`) reaches the caller intact instead
     * of arriving as an anonymous failure.
     */
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (bytes memory)
    {
        if (!isAllowedTarget[target]) revert TargetNotAllowed(target);

        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(result);

        emit Executed(target, value, data);
        return result;
    }

    /**
     * EIP-1271. Tells a caller whether this account authorised a digest.
     *
     * The server uses this to let an account sign a read proof with its owner key:
     * the signature is made by the owner, and the account attests that the owner
     * speaks for it. Without it, a record owned by a contract could never be read,
     * because a contract cannot produce a signature.
     */
    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        if (signature.length != 65) return 0xffffffff;
        if (owner == address(0)) return 0xffffffff;

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) return 0xffffffff;

        // Reject the malleable half of the curve. Without this, any signature has a
        // second valid form, and a replay guard keyed on the signature bytes could
        // be walked around by flipping s.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return 0xffffffff;
        }

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) return 0xffffffff;

        return 0x1626ba7e;
    }

    /// @dev So the dripper can fund this account once it exists.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @dev Same, for a transfer carrying calldata. Vaults and some tools do this.
    fallback() external payable {
        emit Received(msg.sender, msg.value);
    }
}
