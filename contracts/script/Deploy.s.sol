// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PrivateProcurement.sol";
import "../src/PrivatePredictionMarket.sol";

contract DeployPrivateProcurement is Script {
    function run() external returns (PrivateProcurement app) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        app = new PrivateProcurement();
        vm.stopBroadcast();

        console2.log("PrivateProcurement deployed at", address(app));
    }
}

contract DeployPrivatePredictionMarket is Script {
    function run() external returns (PrivatePredictionMarket app) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        app = new PrivatePredictionMarket();
        vm.stopBroadcast();

        console2.log("PrivatePredictionMarket deployed at", address(app));
    }
}
