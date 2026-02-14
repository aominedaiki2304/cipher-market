import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const envPath = path.join(root, ".env");
dotenv.config({ path: envPath });

const DEFAULT_RPC = "https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox";
const DEFAULT_CHAIN_ID = 103698795;
const DEFAULT_USDC = "0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8";

const TRADER_KEYS = ["TRADER_C", "TRADER_D", "TRADER_E"];

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

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[setup-traders:error] ${message}`);
  process.exit(1);
});

async function main() {
  ensureEnvFile();

  // Generate wallets if missing.
  const created = ensureTraderKeys();
  if (created > 0) {
    console.log(`[setup-traders] created ${created} wallet keys in .env (TRADER_C/D/E)`);
  } else {
    console.log("[setup-traders] TRADER_C/D/E already present");
  }

  // Reload env after edits.
  // Preserve any runtime overrides (e.g. RPC_URL=...) while reloading newly written keys.
  dotenv.config({ path: envPath });

  const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
  const chainId = Number(process.env.CHAIN_ID || DEFAULT_CHAIN_ID);
  const usdc = getAddress(process.env.USDC_ADDRESS || DEFAULT_USDC);
  const deployerPk = mustPk(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");

  const deployer = privateKeyToAccount(deployerPk);
  const chain = {
    id: chainId,
    name: "SKALE BITE v2 Sandbox",
    nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } }
  };

  const transport = http(rpcUrl, { retryCount: 5, retryDelay: 1_000, timeout: 60_000 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account: deployer });

  const traders = TRADER_KEYS.map((key) => ({
    key,
    account: privateKeyToAccount(mustPk(process.env[key], key))
  }));

  console.log("[setup-traders] rpc", rpcUrl);
  console.log("[setup-traders] chainId", chainId);
  console.log("[setup-traders] deployer", deployer.address);
  for (const t of traders) {
    console.log(`[setup-traders] ${t.key} address`, t.account.address);
  }

  const minNative = parseEther(process.env.TRADER_MIN_NATIVE || "0.02");
  const targetUsdc = parseUnits(process.env.TRADER_TARGET_USDC || "100", 6);

  for (const t of traders) {
    await topUpNative({ publicClient, walletClient, from: deployer.address, to: t.account.address, minNative });
    await topUpUsdc({ publicClient, walletClient, usdc, to: t.account.address, target: targetUsdc });
  }

  // Summary
  console.log("[setup-traders] balance summary");
  for (const t of traders) {
    const native = await rpc(() => publicClient.getBalance({ address: t.account.address }), "getBalance");
    const bal = await rpc(
      () =>
        publicClient.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [t.account.address]
        }),
      "balanceOf"
    );
    console.log(
      `  ${t.key} ${t.account.address} native=${formatEther(native)} usdc=${formatUnits(bal, 6)}`
    );
  }
}

function ensureEnvFile() {
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, "");
  }
}

function mustPk(value, name) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} missing or invalid (expected 0x + 64 hex chars)`);
  }
  return value;
}

function generatePrivateKeyHex() {
  return `0x${crypto.randomBytes(32).toString("hex")}`;
}

function ensureTraderKeys() {
  let created = 0;
  const existing = new Set(
    ["DEPLOYER_PRIVATE_KEY", "ATTESTOR_PRIVATE_KEY", "TRADER_A", "TRADER_B", ...TRADER_KEYS]
      .map((k) => process.env[k])
      .filter((v) => /^0x[0-9a-fA-F]{64}$/.test(String(v)))
  );

  for (const key of TRADER_KEYS) {
    const value = process.env[key] || "";
    if (/^0x[0-9a-fA-F]{64}$/.test(value)) continue;

    let next = generatePrivateKeyHex();
    while (existing.has(next)) next = generatePrivateKeyHex();
    existing.add(next);

    setEnvValue(envPath, key, next);
    process.env[key] = next;
    created++;
  }

  return created;
}

function setEnvValue(filePath, key, value) {
  const escaped = String(value).replace(/\n/g, "");
  const nextLine = `${key}=${escaped}`;
  let content = "";
  if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, "utf8");

  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  const idx = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = nextLine;
  } else {
    lines.push(nextLine);
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

async function topUpNative({ publicClient, walletClient, from, to, minNative }) {
  const bal = await rpc(() => publicClient.getBalance({ address: to }), "getBalance");
  if (bal >= minNative) return;

  const delta = minNative - bal;
  const hash = await rpc(
    () =>
      walletClient.sendTransaction({
        account: from,
        to,
        value: delta
      }),
    "sendTransaction"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash }), "waitForReceipt");
  console.log("[setup-traders] native top-up", to, "delta", formatEther(delta), "tx", hash);
}

async function topUpUsdc({ publicClient, walletClient, usdc, to, target }) {
  const bal = await rpc(
    () =>
      publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [to]
      }),
    "balanceOf"
  );
  if (bal >= target) return;

  const delta = target - bal;
  const hash = await rpc(
    () =>
      walletClient.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, delta]
      }),
    "transfer"
  );
  await rpc(() => publicClient.waitForTransactionReceipt({ hash }), "waitForReceipt");
  console.log("[setup-traders] usdc top-up", to, "delta", formatUnits(delta, 6), "tx", hash);
}

async function rpc(fn, label) {
  let last;
  for (let i = 0; i < 20; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (i === 19) break;
      const delay = Math.min(10_000, 750 + i * 750);
      await sleep(delay);
      if (process.env.DEBUG_RPC === "1") {
        console.log(`[setup-traders:retry] ${label} attempt=${i + 1} err=${sanitize(error)}`);
      }
    }
  }
  throw new Error(`${label} failed: ${sanitize(last)}`);
}

function sanitize(error) {
  if (!error) return "unknown error";
  return String(error.shortMessage || error.details || error.message || error)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
