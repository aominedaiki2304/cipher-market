const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8787";

async function post(path, body) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

export const api = {
  health: () => fetch(`${API_URL}/health`).then((res) => res.json()),
  encryptOrder: (payload) => post("/api/encrypt-order", payload),
  attestBatchTrigger: (payload) => post("/api/attest-batch-trigger", payload),
  attestResolution: (payload) => post("/api/attest-resolution", payload),
  normalizeReceipt: (payload) => post("/api/normalize-receipt", payload),
  exportTrace: () => post("/api/export-trace", {}),
  fetchDemoReceipts: () => fetch(`${API_URL}/api/demo/receipts`).then((res) => res.json())
};

export { API_URL };
