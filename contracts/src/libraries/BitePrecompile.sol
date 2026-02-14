// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library BitePrecompile {
    address internal constant SUBMIT_CTX_ADDRESS = 0x000000000000000000000000000000000000001B;

    error SubmitCTXCallFailed();
    error SubmitCTXBadReturnLength(uint256 actualLength);

    function submitCTX(
        uint256 gasLimit,
        bytes[] memory encryptedArgs,
        bytes[] memory plaintextArgs
    ) internal returns (address payable ctxSender) {
        (bool ok, bytes memory result) = SUBMIT_CTX_ADDRESS.call(
            abi.encode(gasLimit, abi.encode(encryptedArgs, plaintextArgs))
        );

        if (!ok) revert SubmitCTXCallFailed();
        if (result.length == 20) {
            ctxSender = payable(address(bytes20(result)));
            return ctxSender;
        }
        if (result.length >= 32) {
            ctxSender = payable(abi.decode(result, (address)));
            return ctxSender;
        }

        revert SubmitCTXBadReturnLength(result.length);
    }
}
