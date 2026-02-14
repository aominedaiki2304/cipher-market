import { createConfig, http } from "wagmi";
import { getDefaultConfig } from "connectkit";
import { injected } from "wagmi/connectors";
import { RPC_URL, skaleBiteChain } from "@/lib/env";

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

export const wagmiConfig = createConfig(
  walletConnectProjectId
    ? getDefaultConfig({
        appName: "CipherMarket",
        walletConnectProjectId,
        chains: [skaleBiteChain],
        transports: {
          [skaleBiteChain.id]: http(RPC_URL)
        }
      })
    : {
        chains: [skaleBiteChain],
        connectors: [injected({ shimDisconnect: true })],
        transports: {
          [skaleBiteChain.id]: http(RPC_URL)
        }
      }
);
