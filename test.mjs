/**
 * Standalone test for the Perplexity search provider.
 * Run from this directory:  node test.mjs
 * Stubs globalThis.fetch and the cordis plugin context; asserts wire shape,
 * response mapping, retrieved-length capping (trim + tmp full-copy spill),
 * error paths, and abort handling.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let captured = null;
let fakeResultsOverride = null;
const fakeResults = [
	{ title: "Perplexity docs", url: "https://docs.perplexity.ai/", snippet: "API docs", date: "2026-08-01" },
	{ title: "Search result page", url: "https://perplexity.ai/results", snippet: "search result", date: null },
	{ title: "Dupe", url: "https://docs.perplexity.ai/", snippet: "duplicate url" },
	{ title: "No snippet", url: "https://example.org/x" },
];

globalThis.fetch = async (url, init) => {
	captured = { url: String(url), init };
	if (process.env.FAKE_HTTP === "401") {
		return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
	}
	if (process.env.FAKE_HTTP === "redirect") {
		return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
	}
	return new Response(JSON.stringify({ id: "abc", server_time: "now", results: fakeResultsOverride ?? fakeResults }), { status: 200 });
};

const mod = await import("./index.js");
const {
	PerplexitySearchProvider, PERPLEXITY_PROVIDER_ID, Config, apply, inject, name,
	capRetrievedLength, retrievedCopyName, truncateUtf8, PERPLEXITY_DEFAULT_MAX_RETRIEVED_LENGTH
} = mod;

// ── plugin surface ─────────────────────────────────────────────────────────
assert.equal(PERPLEXITY_PROVIDER_ID, "dsh-search-web-perplexity");
assert.equal(name, "dsh-search-web-perplexity");
assert.deepEqual(inject, ["web"]);
assert.ok(Config, "Config schema exported");
assert.equal(PERPLEXITY_DEFAULT_MAX_RETRIEVED_LENGTH, 4096);
console.log("ok: plugin surface (id, name, inject, Config, default cap 4096)");

// ── fake cordis context ────────────────────────────────────────────────────
const webStub = {
	registered: [],
	registerSearchProvider(p) { this.registered.push(p); return () => {}; },
};

// Minimal mounted-settings simulation: the plugin registers its section via
// ctx.inject(["settings"], (sctx) => sctx.settings.installSection(...)); we
// build a fake scoped ctx whose installSection() wraps register() (mirroring
// SettingsProvider) and returns a live-mutable scope captured in
// `settingsScope` for assertions and hot-reload. `noopInject` models a host
// with no settings service mounted.
let settingsScope = null;
function fakeInject(deps, fn) {
	if (!Array.isArray(deps) || !deps.includes("settings")) return; // not mounted
	const register = (ns, schema, opts) => {
		let value = { ...opts.base };
		const watchers = [];
		settingsScope = {
			ns, schema, opts,
			get: () => value,
			watch: (cb) => watchers.push(cb),
			set(next) { value = { ...next }; watchers.forEach((cb) => cb()); }
		};
		return settingsScope;
	};
	const sctx = {
		settings: {
			register,
			// Mirror SettingsProvider.installSection(owner, ns, schema, entry, hooks):
			// register with the entry as base, hand the provider a live source,
			// fire onChange once, and re-fire on every document update.
			installSection(owner, ns, schema, entry, hooks) {
				const scope = register(ns, schema, { base: entry });
				hooks.setSource(() => scope.get());
				hooks.onChange();
				scope.watch(() => hooks.onChange());
			}
		},
		effect: () => {}
	};
	fn(sctx);
}
const noopInject = () => {}; // settings service not mounted → composed-as-is

const ctx = {
	web: webStub, // injected property (inject: ['web'])
	inject: fakeInject,
	fiber: { state: 0 }, // not unloading/disposed (dsh-settings isUnloading guard)
	get: (id) => {
		if (id === "credentials") return { resolve: async (ref) => (ref === "PERPLEXITY_API_KEY" ? { value: "pplx-test-key" } : undefined) };
		return undefined; // agents → recordRequest no-op
	},
};

// ── apply() registers into ctx.web ─────────────────────────────────────────
apply(ctx, { apiKeyEnv: "PERPLEXITY_API_KEY" });
assert.equal(webStub.registered.length, 1);
const provider = webStub.registered[0];
assert.equal(provider.id, "dsh-search-web-perplexity");
assert.equal(provider.available(), true);
console.log("ok: apply() registers a usable provider under id 'dsh-search-web-perplexity'");

// ── settings section: namespace registered + hot reload ────────────────────
assert.ok(settingsScope, "apply() registered a settings section");
assert.equal(settingsScope.ns, "dsh-search-web-perplexity", "namespace is the plugin's id");
assert.deepEqual(settingsScope.opts.base, { apiKeyEnv: "PERPLEXITY_API_KEY" }, "base is the entry config");
// Hot reload: the provider reads current() per search, so a settings change
// takes effect on the next search without re-applying the plugin.
const hotDir = mkdtempSync(join(tmpdir(), "dsh-search-web-perplexity-hot-"));
fakeResultsOverride = [{ title: "Hot page", url: "https://hot.example/a", snippet: "z".repeat(300), date: null }];
settingsScope.set({ apiKeyEnv: "PERPLEXITY_API_KEY", maxRetrievedLength: 60, retrievedTempDir: hotDir });
const hotResult = await provider.search({ query: "hot reload", maxResults: 3 });
const hotSrc = hotResult.sources[0];
const hotTrimmed = hotSrc.snippet.split("\n\n[retrieved content")[0];
assert.ok(Buffer.byteLength(hotTrimmed, "utf8") <= 60, "hot-changed cap (60) applied, not the old default");
assert.ok(!hotSrc.snippet.includes("z".repeat(61)), "trimmed below the full 300-char length");
assert.ok(hotSrc.snippet.endsWith(`\n\n[retrieved content truncated to 60 bytes; full copy: ${join(hotDir, retrievedCopyName({ url: "https://hot.example/a" }, "hot reload"))}]`), "hot-changed cap + dir honored");
assert.ok(existsSync(join(hotDir, retrievedCopyName({ url: "https://hot.example/a" }, "hot reload"))), "hot spill written to the hot dir");
fakeResultsOverride = null;
rmSync(hotDir, { recursive: true, force: true });
console.log("ok: settings section registered (ns 'dsh-search-web-perplexity') and hot-reloaded");

// ── happy path: wire shape + mapping ───────────────────────────────────────
const result = await provider.search({ query: "hong kong weather", maxResults: 5 });
assert.equal(captured.url, "https://api.perplexity.ai/search");
assert.equal(captured.init.method, "POST");
assert.equal(captured.init.headers.authorization, "Bearer pplx-test-key");
const body = JSON.parse(captured.init.body);
assert.deepEqual(body, { query: "hong kong weather", max_results: 5 });
assert.equal(result.content, undefined, "search must not fabricate an answer");
assert.equal(result.truncated, false);
assert.equal(result.sources.length, 3, "dupes dropped");
assert.deepEqual(result.sources[0], { url: "https://docs.perplexity.ai/", title: "Perplexity docs", snippet: "API docs", publishedAt: "2026-08-01" });
assert.deepEqual(result.sources[1], { url: "https://perplexity.ai/results", title: "Search result page", snippet: "search result" });
assert.deepEqual(result.sources[2], { url: "https://example.org/x", title: "No snippet" });
console.log("ok: wire shape (POST /search, query + max_results) and source mapping");

// ── maxResults fallback + cap ──────────────────────────────────────────────
await provider.search({ query: "q" });
assert.equal(JSON.parse(captured.init.body).max_results, 10, "default 10 when request omits maxResults");
await provider.search({ query: "q", maxResults: 99 });
assert.equal(JSON.parse(captured.init.body).max_results, 20, "capped at the API's 20");
console.log("ok: max_results default (10) and cap (20)");

// ── optional filters ───────────────────────────────────────────────────────
const filteredWeb = { registered: [], registerSearchProvider(p) { this.registered.push(p); return () => {}; } };
const filteredCtx = {
	web: filteredWeb,
	inject: noopInject,
	get: (id) => (id === "credentials" ? { resolve: async () => ({ value: "k" }) } : undefined),
};
apply(filteredCtx, { apiKeyEnv: "PERPLEXITY_API_KEY", searchRecency: "day", searchDomainFilter: ["hkobs.gov.hk"], searchLanguageFilter: ["en"], country: "HK", searchContextSize: "low", maxResults: 7, baseURL: "https://api.perplexity.ai" });
const filtered = filteredWeb.registered[0];
await filtered.search({ query: "q", maxResults: 4 });
const fbody = JSON.parse(captured.init.body);
assert.deepEqual(fbody, { query: "q", max_results: 4, search_recency_filter: "day", search_domain_filter: ["hkobs.gov.hk"], search_language_filter: ["en"], country: "HK", search_context_size: "low" });
console.log("ok: optional filters forwarded on the wire");

// ── retrieved-length cap: trim + tmp full-copy spill ───────────────────────
const capDir = mkdtempSync(join(tmpdir(), "dsh-search-web-perplexity-cap-test-"));
const longSnippet = "x".repeat(9000) + " END-MARKER";
fakeResultsOverride = [
	{ title: "Long page", url: "https://long.example/a", snippet: longSnippet, date: "2026-08-01" },
	{ title: "Short page", url: "https://long.example/b", snippet: "tiny" },
];
const capWeb = { registered: [], registerSearchProvider(p) { this.registered.push(p); return () => {}; } };
const capCtx = { web: capWeb, inject: noopInject, get: (id) => (id === "credentials" ? { resolve: async () => ({ value: "k" }) } : undefined) };
apply(capCtx, { apiKeyEnv: "PERPLEXITY_API_KEY", maxRetrievedLength: 1000, retrievedTempDir: capDir });
const capResult = await capWeb.registered[0].search({ query: "long content", maxResults: 10 });
const [longSrc, shortSrc] = capResult.sources;
assert.equal(shortSrc.snippet, "tiny", "under-limit row untouched");
assert.ok(!longSrc.snippet.includes("END-MARKER"), "over-limit row trimmed");
const expectedPointer = `\n\n[retrieved content truncated to 1000 bytes; full copy: ${join(capDir, retrievedCopyName({ url: "https://long.example/a" }, "long content"))}]`;
assert.ok(longSrc.snippet.endsWith(expectedPointer), "pointer to full copy appended");
const trimmedPart = longSrc.snippet.split("\n\n[retrieved content")[0];
assert.ok(Buffer.byteLength(trimmedPart, "utf8") <= 1000, "trimmed content within budget");
const copyFile = join(capDir, retrievedCopyName({ url: "https://long.example/a" }, "long content"));
assert.ok(existsSync(copyFile), "full copy file written");
const copyText = readFileSync(copyFile, "utf8");
assert.ok(copyText.includes("# Long page"), "copy has title");
assert.ok(copyText.includes("https://long.example/a"), "copy has url");
assert.ok(copyText.includes("Published: 2026-08-01"), "copy has date");
assert.ok(copyText.includes("END-MARKER"), "copy has the FULL snippet");
assert.deepEqual(readdirSync(capDir).sort(), [retrievedCopyName({ url: "https://long.example/a" }, "long content")], "no file for under-limit row");
fakeResultsOverride = null;
rmSync(capDir, { recursive: true, force: true });
console.log("ok: over-limit row trimmed to budget, full copy spilled to tmp with pointer; under-limit row untouched");

// ── UTF-8-safe truncation ──────────────────────────────────────────────────
{
	const cjk = "中".repeat(5000); // 3 bytes each → 15000 bytes
	const out = truncateUtf8(cjk, 100);
	assert.ok(Buffer.byteLength(out, "utf8") <= 100, "within byte budget");
	assert.ok([...out].every((ch) => ch === "中"), "no torn characters");
	assert.ok(!out.includes("\uFFFD"), "no replacement characters");
	const mixed = "abc" + "中".repeat(4000) + "def";
	const out2 = truncateUtf8(mixed, 31);
	assert.ok(Buffer.byteLength(out2, "utf8") <= 31);
	assert.ok(!out2.includes("\uFFFD"));
}
console.log("ok: truncateUtf8 snaps to character boundaries (CJK, mixed)");

// ── cap: write failure degrades gracefully ─────────────────────────────────
{
	// A regular file as the dir's parent → mkdir fails fast with ENOTDIR.
	const { writeFileSync } = await import("node:fs");
	const blocker = join(tmpdir(), `dsh-search-web-perplexity-blocker-${Date.now()}.file`);
	writeFileSync(blocker, "blocker");
	const opts = { maxRetrievedLength: 100, retrievedTempDir: join(blocker, "impossible-subdir") };
	const out = await capRetrievedLength({ url: "https://x.example", snippet: "y".repeat(500) }, opts, "q");
	assert.ok(out.snippet.includes("full copy unavailable"), "degraded pointer on write failure");
	assert.ok(Buffer.byteLength(out.snippet.split("\n\n[")[0], "utf8") <= 100);
	rmSync(blocker, { force: true });
}
console.log("ok: tmp write failure degrades to pointer-less trim (search survives)");

// ── HTTP error path ────────────────────────────────────────────────────────
process.env.FAKE_HTTP = "401";
await assert.rejects(
	provider.search({ query: "q" }),
	(err) => err.code === "WEB_PROVIDER_ERROR" && /Invalid API key/.test(err.message)
);
console.log("ok: non-2xx surfaces WEB_PROVIDER_ERROR with the provider message");

// ── redirect rejection (fetch redirect:'error') ────────────────────────────
process.env.FAKE_HTTP = "redirect";
await assert.rejects(
	provider.search({ query: "q" }),
	(err) => err.code === "WEB_PROVIDER_ERROR"
);
console.log("ok: redirect rejected before contacting the Location target");

// ── missing credential ─────────────────────────────────────────────────────
delete process.env.FAKE_HTTP;
const noKeyProvider = new PerplexitySearchProvider(() => ({
	resolveApiKey: async () => undefined,
	apiKeyEnv: "PERPLEXITY_API_KEY",
	baseURL: "https://api.perplexity.ai",
	maxResults: 10,
	maxRetrievedLength: 4096,
	retrievedTempDir: "/tmp/dsh-search-web-perplexity",
	recordRequest: undefined,
}));
await assert.rejects(
	noKeyProvider.search({ query: "q" }),
	(err) => err.code === "WEB_PROVIDER_CREDENTIAL_MISSING" && /PERPLEXITY_API_KEY/.test(err.message)
);
console.log("ok: missing key surfaces WEB_PROVIDER_CREDENTIAL_MISSING naming the env var");

// ── abort before fetch ─────────────────────────────────────────────────────
const ac = new AbortController();
ac.abort(new Error("dsh-timeout"));
await assert.rejects(
	provider.search({ query: "q" }, ac.signal),
	(err) => err.code === "WEB_ABORTED"
);
console.log("ok: pre-aborted signal surfaces WEB_ABORTED");

console.log("\nALL TESTS PASSED");
