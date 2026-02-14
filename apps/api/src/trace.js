import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const traceDir = path.join(config.rootDir, "artifacts", "traces");
const fullFlowPath = path.join(traceDir, "full-flow.jsonl");

export function appendTrace(eventType, payload) {
  fs.mkdirSync(traceDir, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    eventType,
    payload
  });
  fs.appendFileSync(fullFlowPath, `${line}\n`);
}

export function writeJsonTrace(filename, value) {
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, filename), JSON.stringify(value, null, 2));
}
