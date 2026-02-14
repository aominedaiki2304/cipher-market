# Contracts

## Build

```bash
cd contracts
forge install foundry-rs/forge-std
forge build
```

## Test

```bash
cd contracts
forge test
```

## Deploy

```bash
cd contracts
forge script script/Deploy.s.sol:DeployPrivatePredictionMarket --rpc-url "$RPC_URL" --broadcast
```

Notes:
- `evm_version` is configured to `istanbul` for BITE sandbox compatibility.
- `PrivatePredictionMarket.sol` implements CTX callback flow via `IBiteSupplicant` and the `0x...001B` submitCTX precompile.
- Keep `PrivateProcurement.sol` as legacy reference until final cleanup.
