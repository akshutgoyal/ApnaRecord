// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * A target that records who called it.
 *
 * Test-only, and deliberately never deployed. The account's whole claim is that
 * `execute` makes the TARGET see the account as `msg.sender` — the same mechanism that
 * lets an account own a record and grant access to it. Asserting that against a stub
 * that cannot execute contracts proves nothing, so this exists to be called for real.
 *
 * Not compiled by `npm run compile:contracts` and not shipped; the test compiles it
 * itself.
 */
contract EchoCaller {
    address public lastCaller;
    uint256 public lastValue;
    uint256 public lastArg;
    uint256 public callCount;

    error DeliberateRevert(string reason);

    function ping(uint256 value) external payable returns (uint256) {
        lastCaller = msg.sender;
        lastValue = msg.value;
        lastArg = value;
        callCount += 1;
        return value + 1;
    }

    /// @dev For asserting that the account does not swallow a target's own reason.
    function explode() external pure {
        revert DeliberateRevert("the target said no");
    }
}
