const usd6 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const pct = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

const timeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

export function formatUsdcMicro(value) {
  const asNumber = Number(value || 0) / 1_000_000;
  return usd6.format(asNumber);
}

export function formatPercent(value) {
  const n = Number(value || 0);
  return pct.format(n);
}

export function formatTimestamp(ts) {
  const date = typeof ts === "string" ? new Date(ts) : new Date(Number(ts || Date.now()));
  return timeFmt.format(date);
}
