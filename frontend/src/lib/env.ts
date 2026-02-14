import { defineChain, getAddress, type Address } from "viem";

const FALLBACK_RPC_URL = "https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox";
const FALLBACK_CHAIN_ID = 103698795;
const FALLBACK_USDC = "0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const RPC_URL = import.meta.env.VITE_RPC_URL || FALLBACK_RPC_URL;
export const EXPECTED_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || FALLBACK_CHAIN_ID);
export const PRIVATE_PREDICTION_MARKET_ADDRESS = getAddress(
  (import.meta.env.VITE_PRIVATE_PREDICTION_MARKET_ADDRESS || ZERO_ADDRESS) as Address
);
export const DEFAULT_USDC = getAddress((import.meta.env.VITE_USDC_ADDRESS || FALLBACK_USDC) as Address);
export const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8787";

export const skaleBiteChain = defineChain({
  id: EXPECTED_CHAIN_ID,
  name: "SKALE BITE v2 Sandbox",
  nativeCurrency: {
    name: "sFUEL",
    symbol: "sFUEL",
    decimals: 18
  },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] }
  }
});

