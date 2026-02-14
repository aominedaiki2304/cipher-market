import { Search, Menu, HelpCircle, AlertTriangle, LogOut } from "lucide-react";
import { Link } from "react-router-dom";
import { EXPECTED_CHAIN_ID } from "@/lib/onchain";
import { ConnectKitButton } from "connectkit";
import { useAccount, useChainId, useDisconnect } from "wagmi";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const Header = () => {
  const { address, status } = useAccount();
  const chainId = useChainId();
  const { disconnect } = useDisconnect();
  const isConnecting = status === "connecting";
  const isWrongChain = Boolean(address) && chainId !== EXPECTED_CHAIN_ID;

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4">
        <Link to="/" className="flex shrink-0 items-center gap-2 text-lg font-bold text-foreground">
          <div className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-border/60">
            <img
              src="/ciphermarket-mark.png"
              alt="CipherMarket"
              className="h-7 w-7 object-contain"
              decoding="async"
              loading="eager"
            />
          </div>
          <span className="hidden sm:inline">CipherMarket</span>
        </Link>

        <div className="relative mx-auto max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <input
            type="text"
            placeholder="Search on-chain markets by id/hash"
            className="h-9 w-full rounded-full border border-border bg-muted/50 pl-9 pr-10 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            /
          </kbd>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <button className="hidden items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground md:flex">
            <HelpCircle size={14} />
            On-chain only
          </button>
          {address ? (
            <div className="flex h-9 overflow-hidden rounded-full border border-border">
              <Link
                to="/portfolio"
                className="flex items-center px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                title={address}
              >
                {shortAddress(address)}
              </Link>
              <button
                type="button"
                onClick={() => disconnect()}
                className="flex w-10 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Disconnect"
                aria-label="Disconnect wallet"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <ConnectKitButton.Custom>
              {({ show, isConnecting: ckConnecting }) => (
                <button
                  type="button"
                  disabled={Boolean(isConnecting || ckConnecting)}
                  onClick={() => show?.()}
                  className="h-9 rounded-full border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {isConnecting || ckConnecting ? "Connecting..." : "Connect"}
                </button>
              )}
            </ConnectKitButton.Custom>
          )}
          {isWrongChain ? (
            <div className="hidden items-center gap-1 rounded-full border border-cm-no/40 bg-cm-no-light px-3 py-1 text-xs font-semibold text-cm-no md:flex">
              <AlertTriangle size={12} />
              Chain {chainId} != {EXPECTED_CHAIN_ID}
            </div>
          ) : null}
          <button className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-muted md:hidden">
            <Menu size={20} className="text-foreground" />
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
