export const privatePredictionMarketAbi = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "collateralToken", type: "address" },
          { name: "questionHash", type: "bytes32" },
          { name: "metadataHash", type: "bytes32" },
          { name: "openTime", type: "uint64" },
          { name: "closeTime", type: "uint64" },
          { name: "resolveBy", type: "uint64" },
          { name: "orderDepositUnit", type: "uint256" },
          { name: "maxStakePerOrder", type: "uint256" },
          { name: "maxTotalStake", type: "uint256" },
          { name: "attestor", type: "address" },
          { name: "approver", type: "address" },
          { name: "disputeWindowSeconds", type: "uint64" },
          { name: "allowlistEnabled", type: "bool" },
          { name: "allowlist", type: "address[]" }
        ]
      }
    ],
    outputs: [{ name: "marketId", type: "uint256" }]
  },
  {
    type: "function",
    name: "openMarket",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "submitEncryptedOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "encryptedPayload", type: "bytes" },
      { name: "commitmentHash", type: "bytes32" }
    ],
    outputs: [{ name: "orderId", type: "uint256" }]
  },
  {
    type: "function",
    name: "triggerBatchDecrypt",
    stateMutability: "payable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "orderIds", type: "uint256[]" },
      {
        name: "payload",
        type: "tuple",
        components: [
          { name: "batchId", type: "uint256" },
          { name: "expiry", type: "uint64" },
          { name: "ordersRoot", type: "bytes32" }
        ]
      },
      { name: "attestationSignature", type: "bytes" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "proposeResolution",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "payload",
        type: "tuple",
        components: [
          { name: "marketId", type: "uint256" },
          { name: "outcome", type: "uint8" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "expiry", type: "uint64" }
        ]
      },
      { name: "attestationSignature", type: "bytes" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "openDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "reasonHash", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "overrideResolution",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "finalOutcome", type: "uint8" },
      { name: "reasonHash", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "finalizeResolution",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "claimPayout",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "getMarket",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "creator", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "questionHash", type: "bytes32" },
          { name: "metadataHash", type: "bytes32" },
          { name: "openTime", type: "uint64" },
          { name: "closeTime", type: "uint64" },
          { name: "resolveBy", type: "uint64" },
          { name: "orderDepositUnit", type: "uint256" },
          { name: "maxStakePerOrder", type: "uint256" },
          { name: "maxTotalStake", type: "uint256" },
          { name: "totalEscrowed", type: "uint256" },
          { name: "totalYesStake", type: "uint256" },
          { name: "totalNoStake", type: "uint256" },
          { name: "attestor", type: "address" },
          { name: "approver", type: "address" },
          { name: "disputeWindowSeconds", type: "uint64" },
          { name: "allowlistEnabled", type: "bool" },
          { name: "state", type: "uint8" },
          { name: "proposedOutcome", type: "uint8" },
          { name: "finalOutcome", type: "uint8" },
          { name: "disputeDeadline", type: "uint64" },
          { name: "activeBatchId", type: "uint256" }
        ]
      }
    ]
  },
  {
    type: "event",
    name: "MarketCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "marketId", type: "uint256" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "questionHash", type: "bytes32" },
      { indexed: false, name: "collateralToken", type: "address" },
      { indexed: false, name: "openTime", type: "uint64" },
      { indexed: false, name: "closeTime", type: "uint64" }
    ]
  },
  {
    type: "event",
    name: "OrderSubmitted",
    anonymous: false,
    inputs: [
      { indexed: true, name: "marketId", type: "uint256" },
      { indexed: true, name: "orderId", type: "uint256" },
      { indexed: true, name: "trader", type: "address" },
      { indexed: false, name: "commitmentHash", type: "bytes32" }
    ]
  },
  {
    type: "event",
    name: "ReceiptRecorded",
    anonymous: false,
    inputs: [
      { indexed: true, name: "receiptId", type: "uint256" },
      { indexed: true, name: "marketId", type: "uint256" },
      { indexed: true, name: "orderId", type: "uint256" },
      { indexed: false, name: "trader", type: "address" },
      { indexed: false, name: "status", type: "uint8" },
      { indexed: false, name: "reasonCode", type: "uint8" },
      { indexed: false, name: "conditionPassed", type: "bool" },
      { indexed: false, name: "executed", type: "bool" },
      { indexed: false, name: "side", type: "uint8" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "evidenceHash", type: "bytes32" }
    ]
  }
];
