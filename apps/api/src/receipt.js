export function normalizeReceipt(input) {
  const trader = input.trader ?? input.supplier ?? input.actor ?? "0x0000000000000000000000000000000000000000";

  return {
    receiptId: Number(input.receiptId ?? 0),
    marketId: Number(input.marketId ?? input.policyId ?? 0),
    orderId: Number(input.orderId ?? input.intentId ?? 0),
    trader,
    actor: trader,
    status: String(input.status ?? "UNKNOWN"),
    reasonCode: String(input.reasonCode ?? "NONE"),
    conditionPassed: Boolean(input.conditionPassed),
    executed: Boolean(input.executed),
    side: String(input.side ?? "NONE"),
    amount: String(input.amount ?? "0"),
    token: input.token ?? "0x0000000000000000000000000000000000000000",
    evidenceHash: input.evidenceHash ?? "0x",
    timestamp: input.timestamp ?? new Date().toISOString(),
    evidence: {
      encryptionMode: input.encryptionMode ?? "unknown",
      txHash: input.txHash ?? null,
      ctxSender: input.ctxSender ?? null
    }
  };
}
