#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

function getFlagValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  throw new Error("RPC_URL missing in env");
}
const CHAIN_ID = Number(process.env.CHAIN_ID || 103698795);
const USDC_ADDRESS = getAddress(process.env.USDC_ADDRESS || "0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8");

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || "";
if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
  throw new Error("DEPLOYER_PRIVATE_KEY missing/invalid in env");
}

const traderBKey = process.env.TRADER_B || process.env.ATTESTOR_PRIVATE_KEY || "";
if (!/^0x[0-9a-fA-F]{64}$/.test(traderBKey)) {
  throw new Error("TRADER_B (or ATTESTOR_PRIVATE_KEY) missing/invalid in env");
}

const amountInput = getFlagValue("--amount") || "900";
const toInput = getFlagValue("--to") || "traderB";
const execute = hasFlag("--yes");

const chain = {
  id: CHAIN_ID,
  name: "SKALE BITE v2 Sandbox",
  nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } }
};

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
];

const deployer = privateKeyToAccount(deployerKey);
const traderB = privateKeyToAccount(traderBKey);

const toAddress = toInput.toLowerCase() === "traderb" ? traderB.address : getAddress(toInput);
const amount = parseUnits(amountInput, 6);

const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 2 })
});

const [fromNative, toNative, fromUsdc, toUsdc] = await Promise.all([
  publicClient.getBalance({ address: deployer.address }),
  publicClient.getBalance({ address: toAddress }),
  publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [deployer.address]
  }),
  publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [toAddress]
  })
]);

console.log("[usdc] chainId", CHAIN_ID);
console.log("[usdc] token", USDC_ADDRESS);
console.log("[usdc] from", deployer.address, "native", formatEther(fromNative), "usdc", formatUnits(fromUsdc, 6));
console.log("[usdc] to  ", toAddress, "native", formatEther(toNative), "usdc", formatUnits(toUsdc, 6));
console.log("[usdc] amount", formatUnits(amount, 6), "USDC");

if (!execute) {
  console.log("[usdc] dry-run. Re-run with --yes to broadcast.");
  process.exit(0);
}

if (fromUsdc < amount) {
  throw new Error(`Insufficient deployer USDC. Have ${formatUnits(fromUsdc, 6)}, need ${formatUnits(amount, 6)}.`);
}

const walletClient = createWalletClient({
  chain,
  transport: http(RPC_URL, { retryCount: 2 }),
  account: deployer
});

const txHash = await walletClient.writeContract({
  address: USDC_ADDRESS,
  abi: erc20Abi,
  functionName: "transfer",
  args: [toAddress, amount]
});

console.log("[usdc] transfer tx", txHash);
await publicClient.waitForTransactionReceipt({ hash: txHash });

const [fromAfter, toAfter] = await Promise.all([
  publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [deployer.address]
  }),
  publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [toAddress]
  })
]);

console.log("[usdc] after from usdc", formatUnits(fromAfter, 6));
console.log("[usdc] after to   usdc", formatUnits(toAfter, 6));

