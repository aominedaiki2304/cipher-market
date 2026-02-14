import { config } from "./config.js";
import { createApp } from "./app.js";
import { startRelayer } from "./relayer.js";

const app = createApp();

app.listen(config.apiPort, "0.0.0.0", () => {
  console.log(`[api] listening on 0.0.0.0:${config.apiPort}`);
});

// Background relayer: triggers CTX decrypt after close and proposes/finalizes resolution.
startRelayer();
