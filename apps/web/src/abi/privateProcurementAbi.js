export const privateProcurementAbi = [
  {
    type: "function",
    name: "createPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentToken", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "spendCapPerIntent", type: "uint256" },
      { name: "allowlistedSuppliers", type: "address[]" },
      { name: "attestor", type: "address" },
      { name: "approver", type: "address" },
      { name: "manualApprovalThreshold", type: "uint256" }
    ],
    outputs: [{ name: "policyId", type: "uint256" }]
  },
  {
    type: "function",
    name: "fundPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "policyId", type: "uint256" },
      { name: "amount", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "createEncryptedIntent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "policyId", type: "uint256" },
      { name: "encryptedPayload", type: "bytes" },
      { name: "commitmentHash", type: "bytes32" }
    ],
    outputs: [{ name: "intentId", type: "uint256" }]
  },
  {
    type: "function",
    name: "triggerIntent",
    stateMutability: "payable",
    inputs: [
      { name: "intentId", type: "uint256" },
      {
        name: "payload",
        type: "tuple",
        components: [
          { name: "deliveryProofHash", type: "bytes32" },
          { name: "quoteHash", type: "bytes32" },
          { name: "expiry", type: "uint64" }
        ]
      },
      { name: "attestationSignature", type: "bytes" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "approveAndExecute",
    stateMutability: "nonpayable",
    inputs: [{ name: "intentId", type: "uint256" }],
    outputs: []
  },
  {
    type: "event",
    name: "PolicyCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "policyId", type: "uint256" },
      { indexed: true, name: "buyer", type: "address" },
      { indexed: true, name: "paymentToken", type: "address" },
      { indexed: false, name: "budget", type: "uint256" },
      { indexed: false, name: "spendCapPerIntent", type: "uint256" },
      { indexed: false, name: "manualApprovalThreshold", type: "uint256" },
      { indexed: false, name: "attestor", type: "address" },
      { indexed: false, name: "approver", type: "address" }
    ]
  },
  {
    type: "event",
    name: "IntentCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "intentId", type: "uint256" },
      { indexed: true, name: "policyId", type: "uint256" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "commitmentHash", type: "bytes32" }
    ]
  },
  {
    type: "event",
    name: "ReceiptRecorded",
    anonymous: false,
    inputs: [
      { indexed: true, name: "receiptId", type: "uint256" },
      { indexed: true, name: "intentId", type: "uint256" },
      { indexed: true, name: "policyId", type: "uint256" },
      { indexed: false, name: "status", type: "uint8" },
      { indexed: false, name: "reasonCode", type: "uint8" },
      { indexed: false, name: "conditionPassed", type: "bool" },
      { indexed: false, name: "executed", type: "bool" },
      { indexed: false, name: "supplier", type: "address" },
      { indexed: false, name: "amount", type: "uint256" }
    ]
  }
];
