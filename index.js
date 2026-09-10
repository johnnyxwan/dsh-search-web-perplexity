/**
 * `dsh-search-web-perplexity` — DSH profile plugin: a Perplexity-backed
 * search provider for the web capability seam (`ctx.web`) that uses Perplexity's
 * model-agnostic Search API (`POST /search`) instead of the Sonar
 * chat-completions route.
 *
 * The Search API returns retrieved web pages directly — title, url, extracted
 * snippet, publication date — with no LLM answer generation: no model tokens
 * are spent on the auxiliary call, no generated prose reaches the model's
 * context, and `max_results` is honored at the wire layer (not by post-hoc
 * truncation). The normalized result therefore carries `sources[]` only — no
 * `content`.
 *
 * Retrieved-length control: each source's retrieved content (`snippet`) is
 * capped at `maxRetrievedLength` bytes (default 4096) when placed into the
 * tool result. An over-limit row is trimmed in-place, its FULL copy is
 * written to a file under `retrievedTempDir` (default
 * `<tmpdir>/dsh-search-web-perplexity/`), and the trimmed snippet carries
 * the file path so the model can `read` the full text on demand.
 *
 * Registration: function/namespace plugin (`inject: ['web']`); it registers
 * into the seam's search-provider registry under the id `dsh-search-web-perplexity` and
 * owns no model-facing tool. Wire format and the native `fetch` client are
 * provider-private and do not use `ctx.llm`.
 *
 * Install:  dsh plugin --profile <name> add <this repo's git URL> (see README).
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
// Settings section is registered via ctx.settings.installSection (dsh >= 0.1.2-rc.1); no value import from @deepseek-ai/dsh-settings.

/** Stable id this provider registers under. */
const PERPLEXITY_PROVIDER_ID = "dsh-search-web-perplexity";

/** Settings namespace this plugin owns; the join key for its settings card. */
const PERPLEXITY_SETTINGS_NAMESPACE = "dsh-search-web-perplexity";

/** Default Perplexity endpoint; `/search` is appended (the Search API). */
const PERPLEXITY_DEFAULT_BASE_URL = "https://api.perplexity.ai";

/** Default environment variable / credential name for the API key. */
const PERPLEXITY_DEFAULT_API_KEY_ENV = "PERPLEXITY_API_KEY";

/** Default wire-level result cap (API default). */
const PERPLEXITY_DEFAULT_MAX_RESULTS = 10;

/** Hard result cap accepted by the Search API. */
const PERPLEXITY_MAX_RESULTS_CAP = 20;

/** Default per-source retrieved-content cap, in bytes. */
const PERPLEXITY_DEFAULT_MAX_RETRIEVED_LENGTH = 4096;

/** Default directory for full copies of over-limit retrieved content. */
const PERPLEXITY_DEFAULT_TEMP_DIRNAME = "dsh-search-web-perplexity";

/** Attribution header sent on every request. */
const USER_AGENT = "deepseek-harness/0.0.1 (dsh-search-web-perplexity)";

/**
 * Map one Search API result page to a normalized source.
 *
 * @param item - one entry of the response's `results[]`.
 * @returns the normalized source; blank fields are omitted rather than set empty.
 */
function mapSearchResult(item) {
	return {
		url: item.url,
		...item.title != null && item.title.length > 0 ? { title: item.title } : {},
		...item.snippet != null && item.snippet.length > 0 ? { snippet: item.snippet } : {},
		...item.date != null && item.date.length > 0 ? { publishedAt: item.date } : {}
	};
}

/**
 * Map a Search API response envelope to a normalized search result.
 * There is no generated answer on this route, so `content` is never set.
 * Sources are deduped by url; the seam owns the final `maxResults` bound and
 * the caller owns the per-source retrieved-length cap.
 *
 * @param response - the parsed `/search` response body.
 * @returns the normalized result.
 * @throws {WebError} when the body lacks a `results[]` array.
 */
function mapSearchResponse(response) {
	const results = response.results;
	if (!Array.isArray(results)) throw new WebError(
		"Perplexity returned an unprocessable response body: missing results[]",
		"WEB_PROVIDER_ERROR"
	);
	const seen = new Set();
	const sources = [];
	for (const item of results) {
		if (item == null || typeof item.url !== "string" || item.url.length === 0 || seen.has(item.url)) continue;
		seen.add(item.url);
		sources.push(mapSearchResult(item));
	}
	return { sources, truncated: false };
}

/**
 * Longest UTF-8-safe prefix of `str` whose encoding is at most `maxBytes`
 * bytes. Snaps back to a character boundary so the prefix is always valid
 * UTF-8 (never a torn multi-byte sequence).
 *
 * @param str - the input string.
 * @param maxBytes - the byte budget.
 * @returns the truncated (or unchanged) string.
 */
function truncateUtf8(str, maxBytes) {
	const buf = Buffer.from(str, "utf8");
	if (buf.length <= maxBytes) return str;
	let end = maxBytes;
	// Walk back past continuation bytes (10xxxxxx) to a character boundary.
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

/** Stable per-source file name: sha256(url + query), 16 hex chars. */
function retrievedCopyName(source, query) {
	return `${createHash("sha256").update(`${source.url}\n${query ?? ""}`).digest("hex").slice(0, 16)}.txt`;
}

/** File name of the plugin-local search-request diagnostic log. */
const REQUEST_LOG_FILENAME = "requests.jsonl";

/**
 * Append one search-request diagnostic record to the plugin-local JSONL file
 * under `dir` (the same ephemeral location as the full-copy spills).
 * Fire-and-forget: the record is purely informational — losing it cannot
 * affect anything the harness reconstructs — so a tmp-write failure (missing
 * dir, disk pressure, permissions) is swallowed rather than failing the search.
 *
 * @param request - the record ({ endpoint, body }).
 * @param dir - the plugin's retrieved-temp directory (created lazily).
 */
function recordRequestLocally(request, dir) {
	const line = JSON.stringify({ ...request, time: Date.now() }) + "\n";
	mkdir(dir, { recursive: true })
		.then(() => appendFile(join(dir, REQUEST_LOG_FILENAME), line, "utf8"))
		.catch(() => {
			// Diagnostic-only: never fail a search over a tmp write.
		});
}

/** Render the full copy of one source row (title, url, date, full content). */
function renderFullCopy(source) {
	return [
		source.title != null && source.title.length > 0 ? `# ${source.title}` : null,
		source.url,
		source.publishedAt != null && source.publishedAt.length > 0 ? `Published: ${source.publishedAt}` : null,
		"",
		source.snippet ?? ""
	].filter((line) => line !== null).join("\n");
}

/**
 * Enforce the per-source retrieved-length cap on one source. Under the cap,
 * the source is returned unchanged. Over the cap, the full row is written to
 * `options.retrievedTempDir` and the source's snippet is replaced with the
 * truncated content plus a pointer to the full-copy file.
 *
 * @param source - the normalized source.
 * @param options - resolved provider options (maxRetrievedLength, retrievedTempDir).
 * @param query - the search query (namespaces the copy file).
 * @returns the source, possibly with a trimmed snippet + full-copy pointer.
 */
async function capRetrievedLength(source, options, query) {
	const snippet = source.snippet ?? "";
	const limit = options.maxRetrievedLength;
	if (Buffer.byteLength(snippet, "utf8") <= limit) return source;

	const dir = options.retrievedTempDir;
	const file = join(dir, retrievedCopyName(source, query));
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(file, renderFullCopy(source), "utf8");
	} catch (error) {
		// Losing the full copy degrades the pointer; never fail the search
		// over a tmp write (disk pressure, permissions). Trim without it.
		return { ...source, snippet: `${truncateUtf8(snippet, limit)}\n\n[retrieved content truncated to ${limit} bytes; full copy unavailable: ${String(error)}]` };
	}
	return {
		...source,
		snippet: `${truncateUtf8(snippet, limit)}\n\n[retrieved content truncated to ${limit} bytes; full copy: ${file}]`
	};
}

/**
 * The Perplexity search provider. Credentials resolve per request
 * (managed credential store, then launch environment); HTTP redirects fail
 * as `WEB_PROVIDER_ERROR`; aborts surface as `WEB_ABORTED`.
 */
class PerplexitySearchProvider {
	id = PERPLEXITY_PROVIDER_ID;
	#resolveOptions;

	/**
	 * @param resolveOptions - the options for the NEXT operation, snapshotted
	 * once at each operation's entry so one search never mixes two sections.
	 */
	constructor(resolveOptions) {
		this.#resolveOptions = resolveOptions;
	}

	/** Cheap local usability check; never makes network calls. */
	available() {
		const options = this.#resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
			&& URL.canParse(options.baseURL)
			&& isPositiveInteger(options.maxResults)
			&& isPositiveInteger(options.maxRetrievedLength);
	}

	async search(request, signal) {
		const options = this.#resolveOptions();
		const apiKey = await this.#apiKey(options, signal);
		throwIfAborted(signal);

		// The seam always sends maxResults from dsh-tool-web; when absent,
		// fall back to the configured default. The API caps at 20.
		const maxResults = Math.min(request.maxResults ?? options.maxResults, PERPLEXITY_MAX_RESULTS_CAP);
		const endpoint = `${options.baseURL}/search`;
		const body = { query: request.query, max_results: maxResults };
		if (options.searchRecency !== undefined) body.search_recency_filter = options.searchRecency;
		if (options.searchDomainFilter != null && options.searchDomainFilter.length > 0) body.search_domain_filter = options.searchDomainFilter;
		if (options.searchLanguageFilter != null && options.searchLanguageFilter.length > 0) body.search_language_filter = options.searchLanguageFilter;
		if (options.country !== undefined) body.country = options.country;
		if (options.searchContextSize !== undefined) body.search_context_size = options.searchContextSize;

		options.recordRequest?.({ endpoint, body });
		throwIfAborted(signal);

		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== undefined ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Perplexity search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}

		if (!response.ok) {
			let message = `Perplexity API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
				if (detail !== undefined && detail.length > 0) message = detail;
			} catch (error) {
				// An abort firing mid-body must surface as WEB_ABORTED, not be
				// swallowed into a generic HTTP-error message.
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}

		let result;
		try {
			result = mapSearchResponse(await response.json());
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(`Perplexity returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}

		// Per-source retrieved-length cap with full-copy spill to tmp.
		result.sources = await Promise.all(result.sources.map((source) => capRetrievedLength(source, options, request.query)));
		return result;
	}

	/**
	 * Resolve one operation's credential without retaining it on the provider.
	 * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
	 * @param signal - abort signal for the surrounding search.
	 * @returns the resolved key.
	 */
	async #apiKey(options, signal) {
		throwIfAborted(signal);
		if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Perplexity search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== undefined && resolved.length > 0) return resolved;
		throw new WebError(
			`Perplexity search has no API key for "${options.apiKeyEnv ?? PERPLEXITY_DEFAULT_API_KEY_ENV}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the dsh-search-web-perplexity config`,
			"WEB_PROVIDER_CREDENTIAL_MISSING"
		);
	}
}

/**
 * Project one config section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? PERPLEXITY_DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined;
	const retrievedTempDir = config.retrievedTempDir ?? join(tmpdir(), PERPLEXITY_DEFAULT_TEMP_DIRNAME);
	return {
		...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
		},
		apiKeyEnv: config.apiKeyEnv ?? PERPLEXITY_DEFAULT_API_KEY_ENV,
		baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get("PERPLEXITY_SEARCH_BASE_URL")?.value ?? PERPLEXITY_DEFAULT_BASE_URL,
		maxResults: config.maxResults ?? PERPLEXITY_DEFAULT_MAX_RESULTS,
		maxRetrievedLength: config.maxRetrievedLength ?? PERPLEXITY_DEFAULT_MAX_RETRIEVED_LENGTH,
		retrievedTempDir,
		...config.searchRecency !== undefined ? { searchRecency: config.searchRecency } : {},
		...config.searchDomainFilter !== undefined ? { searchDomainFilter: config.searchDomainFilter } : {},
		...config.searchLanguageFilter !== undefined ? { searchLanguageFilter: config.searchLanguageFilter } : {},
		...config.country !== undefined ? { country: config.country } : {},
		...config.searchContextSize !== undefined ? { searchContextSize: config.searchContextSize } : {},
		recordRequest: (request) => {
			// Diagnostic only — deliberately NOT a session-log event.
			//
			// `web/perplexity-search-request` is a plugin-owned event type,
			// outside the harness's build-static known-event catalog by
			// construction, and the persistence read path refuses unknown
			// types unless the event carries the `ignorable` envelope flag.
			// `Session.append` CANNOT carry that flag: its options parameter
			// is the surface intent (surfaceOp / sourceEventSeqs only), and
			// an `ignorable` key passed there is silently dropped, so the
			// event persists UNMARKED. Any harness build that lacks this type
			// in its catalog then refuses to load the session's history at
			// all — a diagnostic record must never poison the durable log.
			// The record therefore goes to a local, ephemeral JSONL file
			// under the retrieved-temp directory instead: losing it cannot
			// affect session reconstruction, and no harness can choke on it.
			recordRequestLocally(request, retrievedTempDir);
		}
	};
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-search-web-perplexity";

/** The web seam this provider registers into. */
export const inject = ["web"];

/** Plugin config (all fields optional; defaults resolve at request time). */
export const Config = z.object({
	/** Literal API key; overrides the credential reference. */
	apiKey: z.string().role("secret"),
	/** Credential/environment name for the API key. */
	apiKeyEnv: z.string().role("credential-ref").default(PERPLEXITY_DEFAULT_API_KEY_ENV),
	/** Endpoint base; `/search` is appended. */
	baseURL: z.string(),
	/** Wire-level result cap (API hard cap: 20). */
	maxResults: z.number().step(1).min(1).max(PERPLEXITY_MAX_RESULTS_CAP).default(PERPLEXITY_DEFAULT_MAX_RESULTS),
	/** Per-source retrieved-content cap in bytes; over-limit rows spill to a full-copy file. */
	maxRetrievedLength: z.number().step(1).min(1).default(PERPLEXITY_DEFAULT_MAX_RETRIEVED_LENGTH),
	/** Directory for full copies of over-limit retrieved content. */
	retrievedTempDir: z.string(),
	/** Recency window sent as `search_recency_filter`. */
	searchRecency: z.union(["hour", "day", "week", "month", "year"]),
	/** Domains to limit results to (max 20). */
	searchDomainFilter: z.array(z.string()),
	/** ISO 639-1 language codes (max 20). */
	searchLanguageFilter: z.array(z.string()),
	/** ISO 3166-1 alpha-2 country code. */
	country: z.string(),
	/** Content extraction depth: low | medium | high (default high server-side). */
	searchContextSize: z.union(["low", "medium", "high"])
});

/**
 * Register the Perplexity search provider with `ctx.web`, and layer the
 * entry under the user settings document so the section is hot-editable and
 * claimable by a settings card (namespace is the join key for both halves).
 *
 * @param ctx - plugin context.
 * @param config - the composition entry config (the section's `base`).
 */
export function apply(ctx, config) {
	let current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, PERPLEXITY_SETTINGS_NAMESPACE, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				// The provider reads `current()` per search; nothing else to rebuild.
			}
		});
	});
	ctx.web.registerSearchProvider(new PerplexitySearchProvider(() => resolveOptions(ctx, current())));
}

export {
	PERPLEXITY_DEFAULT_BASE_URL,
	PERPLEXITY_DEFAULT_API_KEY_ENV,
	PERPLEXITY_DEFAULT_MAX_RETRIEVED_LENGTH,
	PERPLEXITY_PROVIDER_ID,
	PERPLEXITY_SETTINGS_NAMESPACE,
	PerplexitySearchProvider,
	capRetrievedLength,
	renderFullCopy,
	retrievedCopyName,
	truncateUtf8
};

/* jscpd:ignore-start */
/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Perplexity search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** True for a positive whole number (a limit that can be sent or enforced). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation, signal) {
	if (signal === undefined) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}
/* jscpd:ignore-end */
