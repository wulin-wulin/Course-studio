import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let resolveBackendWsUrl;

before(async () => {
  const result = await build({
    stdin: {
      contents: 'export { resolveBackendWsUrl } from "./src/utils/backendWs.ts";',
      resolveDir: frontendRoot,
      sourcefile: "backend-ws-test-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
  });
  const output = result.outputFiles?.[0];
  assert.ok(output);
  ({ resolveBackendWsUrl } = await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
  ));
});

test("uses the page origin for an unconfigured LAN websocket", () => {
  assert.equal(
    resolveBackendWsUrl(
      "/api/agent/ws",
      { protocol: "http:", host: "10.180.229.218:5173" },
    ),
    "ws://10.180.229.218:5173/api/agent/ws",
  );
});

test("uses a secure page origin when the page is served over HTTPS", () => {
  assert.equal(
    resolveBackendWsUrl(
      "api/agent/ws",
      { protocol: "https:", host: "course.example.test" },
    ),
    "wss://course.example.test/api/agent/ws",
  );
});

test("keeps an explicitly configured websocket URL", () => {
  assert.equal(
    resolveBackendWsUrl(
      "/api/agent/ws",
      { protocol: "http:", host: "10.180.229.218:5173" },
      "wss://agent.example.test/",
    ),
    "wss://agent.example.test/api/agent/ws",
  );
});
