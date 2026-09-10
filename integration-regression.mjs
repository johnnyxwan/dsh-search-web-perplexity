/**
 * End-to-end regression check: drive the REAL plugin (apply → provider →
 * search) against a REAL harness Session, then run the harness's own
 * persistence validation (validateStoredEvents) on the session's events —
 * exactly the function whose refusal breaks history loading for a log that
 * contains an unmarked plugin-owned event.
 *
 * Requires the harness packages resolvable from this directory (node_modules
 * symlinked to the dsh profile's hoisted tree, see .gitignore), then run:
 *   node integration-regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session } from "@deepseek-ai/dsh-session";
import { validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";

// Stub the network: one successful search.
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://api.perplexity.ai/search");
  return new Response(JSON.stringify({
    id: "integration",
    server_time: "now",
    results: [{ title: "Example", url: "https://example.com/", snippet: "An example result.", date: "2026-01-01" }]
  }), { status: 200 });
};

const diagDir = mkdtempSync(join(tmpdir(), "dsh-pplx-integration-"));
const session = Session.create("session-integration-regression-search", undefined, {
  version: 3,
  id: "session-integration-regression-search",
  createdAt: Date.now(),
  isSeeded: false
});
let provider = null;
const ctx = {
  web: { registerSearchProvider(p) { provider = p; } },
  inject: () => {},
  fiber: { state: 0 },
  get: (id) => {
    if (id === "credentials") return { resolve: async () => ({ value: "integration-key" }) };
    if (id === "agents") return { currentInitiator: () => ({ session }) };
    return undefined;
  }
};

const { apply } = await import("./index.js");
apply(ctx, { apiKeyEnv: "PERPLEXITY_API_KEY", retrievedTempDir: diagDir });
assert.ok(provider, "provider registered");

const result = await provider.search({ query: "hong kong weather", maxResults: 5 });
assert.equal(result.sources.length, 1, "search succeeds end to end");

// The record write is fire-and-forget; give it a tick to settle.
await new Promise((resolve) => setTimeout(resolve, 50));

// 1. No plugin-owned event may exist in the durable session log.
const events = session.snapshotEvents();
const pluginEvents = events.filter((e) => e.type.startsWith("web/perplexity"));
assert.deepEqual(pluginEvents, [], `session log contains plugin-owned events: ${pluginEvents.map((e) => e.type)}`);

// 2. The harness's own persistence validation must pass on this build's
//    known-event catalog — which does NOT include web/perplexity-search-request.
validateStoredEvents(session.header, events, { path: "integration-regression" });

// 3. The diagnostic record exists in the ephemeral local file instead.
const diagFile = join(diagDir, "requests.jsonl");
assert.ok(existsSync(diagFile), "requests.jsonl written under the retrieved-temp dir");
const [record] = readFileSync(diagFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(record.endpoint, "https://api.perplexity.ai/search");
assert.equal(record.body.query, "hong kong weather");
assert.equal(record.body.max_results, 5);
assert.equal(typeof record.time, "number");

console.log("ok: search works, session log stays clean, validateStoredEvents passes, diagnostic recorded locally");
rmSync(diagDir, { recursive: true, force: true });
console.log("INTEGRATION REGRESSION PASSED");
