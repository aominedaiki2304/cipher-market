// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBiteSupplicant {
    function onDecrypt(
        bytes[] calldata decryptedArguments,
        bytes[] calldata plaintextArguments
    ) external;
}
