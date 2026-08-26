#!/usr/bin/env node
/**
 * Installs the dsh-search-web-perplexity profile plugin into a DSH home.
 *
 * Usage:
 *   node install.mjs [--dsh-home DIR] [--profile NAME] [--no-activate]
 *
 * Defaults: DSH_HOME env var or ~/.dsh; profile "web".
 *
 * What it does (all idempotent — safe to re-run):
 *   1. Extracts the plugin package next to the profile:
 *        <dsh-home>/profiles/<profile>/plugins/dsh-search-web-perplexity/
 *   2. Symlinks it into the profile's node_modules under its package name,
 *      which is what BOTH the host loader and the client-card discovery
 *      resolve by bare name (the profile's own node_modules is on the
 *      resolution path; no global-install or pnpm involvement).
 *   3. Appends a marked entry block to the profile's cordis.patch.yml:
 *        - insert: dsh-search-web-perplexity (name + config)
 *        - id: web  -> searchProvider: dsh-search-web-perplexity   (skipped with --no-activate)
 *        - id: web-search-deepseek -> disabled: true    (skipped with --no-activate)
 *   4. Checks the credentials store for PERPLEXITY_API_KEY and reports.
 *
 * The plugin's dsh-internal dependencies (dsh-settings, dsh-web,
 * dsh-credentials, dsh-launch-environment, schemastery) are NOT bundled —
 * they resolve from the target's dsh installation, so install on the same
 * dsh version as this kit was built against (0.1.0-rc.7).
 */
import { execFileSync } from "node:child_process";
import { lstat, access, mkdir, readFile, writeFile, appendFile, symlink, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "dsh-search-web-perplexity";
const PLUGIN_DIRNAME = "dsh-search-web-perplexity";
const MARKER_HEAD = `# >>> ${PKG_NAME} (managed block — uninstall.mjs removes this) >>>`;
const MARKER_TAIL = `# <<< ${PKG_NAME} <<<`;
const KNOWN_GOOD_DSH = "0.1.0-rc.7";

/** Escape regex metacharacters so the marker strings match literally. */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
const BLOCK_RE = new RegExp(`\\n?${escapeRegExp(MARKER_HEAD)}[\\s\\S]*?${escapeRegExp(MARKER_TAIL)}\\n?`);

function args() {
	const out = { dshHome: void 0, profile: "web", activate: true };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dsh-home") out.dshHome = argv[++i];
		else if (argv[i] === "--profile") out.profile = argv[++i];
		else if (argv[i] === "--no-activate") out.activate = false;
		else { console.error(`unknown flag: ${argv[i]}`); process.exit(2); }
	}
	return out;
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

const opts = args();
const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", opts.profile);
const pluginDir = join(profileDir, "plugins", PLUGIN_DIRNAME);
const patchPath = join(profileDir, "cordis.patch.yml");

console.log(`DSH home:   ${dshHome}`);
console.log(`Profile:    ${opts.profile}`);

if (!(await exists(profileDir))) {
	console.error(`profile directory not found: ${profileDir} — is this a DSH home with a "${opts.profile}" profile?`);
	process.exit(1);
}

// ── 0. dsh version sanity (best effort) ──────────────────────────────────────
try {
	const v = execFileSync("dsh", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim().split("\n").pop();
	console.log(`dsh on PATH: ${v}${v !== KNOWN_GOOD_DSH ? `  (warning: kit built against ${KNOWN_GOOD_DSH})` : "  (matches kit)"}`);
} catch {
	console.log("dsh on PATH: (not found or no --version — skipping sanity check)");
}

// ── 1. extract the plugin package ────────────────────────────────────────────
const tgz = join(HERE, `${PKG_NAME}.tar.gz`);
if (!(await exists(tgz))) { console.error(`missing tarball next to this script: ${tgz}`); process.exit(1); }
await rm(pluginDir, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });
execFileSync("tar", ["-xzf", tgz, "-C", pluginDir]);
const files = ["package.json", "index.js", "client.js", "test.mjs", "test-client.mjs"];
for (const f of files) if (!(await exists(join(pluginDir, f)))) { console.error(`tarball missing ${f}`); process.exit(1); }
console.log(`1/4 plugin files -> ${pluginDir}`);

// ── 2. profile-local node_modules symlink (bare-name resolution) ─────────────
const nmDir = join(profileDir, "node_modules");
const linkPath = join(nmDir, PKG_NAME);
await mkdir(nmDir, { recursive: true });
try { const st = await lstat(linkPath); if (st.isSymbolicLink() || st.isDirectory()) await rm(linkPath, { recursive: true, force: true }); } catch { /* absent */ }
await symlink(pluginDir, linkPath);
console.log(`2/4 symlink      ${linkPath} -> ${pluginDir}`);

// ── 3. patch entries ─────────────────────────────────────────────────────────
const patchBlock = [
	"",
	MARKER_HEAD,
	"# Perplexity search (POST /search, model-agnostic): provider plugin +",
	"# settings card. The package resolves by bare name via the profile-local",
	"# node_modules symlink; the API key resolves per request from the",
	"# credentials store, the environment, or a literal config.apiKey.",
	"- insert:",
	"    - id: dsh-search-web-perplexity",
	"      name: 'dsh-search-web-perplexity'",
	"      config:",
	"        apiKeyEnv: PERPLEXITY_API_KEY",
	"        # maxRetrievedLength (bytes): per-source retrieved-content cap;",
	"        # over-limit rows are trimmed and the full copy spills to a tmp file",
	"        # whose path is left in the tool context. Also editable in the GUI.",
	"        maxRetrievedLength: 4096",
];
if (opts.activate) {
	patchBlock.push(
		"",
		"- id: web",
		"  name: '@deepseek-ai/dsh-web'",
		"  config:",
		"    searchProvider: dsh-search-web-perplexity",
		"",
		"# Uninstall-from-this-profile: disable the bundled DeepSeek provider row",
		"# so only dsh-search-web-perplexity is registered.",
		"- id: web-search-deepseek",
		"  disabled: true",
	);
}
patchBlock.push(MARKER_TAIL, "");

const existing = await (await exists(patchPath) ? readFile(patchPath, "utf8") : "");
if (existing.includes("id: dsh-search-web-perplexity")) {
	console.log("3/4 patch        already contains dsh-search-web-perplexity — leaving cordis.patch.yml untouched");
} else if (existing.includes(MARKER_HEAD)) {
	console.log("3/4 patch        stale managed block found without the entry — replacing it");
	await writeFile(patchPath, existing.replace(BLOCK_RE, "\n") + patchBlock.join("\n"));
} else {
	const header = existing === "" ? "# Patch layer for this dsh profile (top-level YAML array of loader patch entries).\n" : "";
	await writeFile(patchPath, header + existing + patchBlock.join("\n"));
	console.log(`3/4 patch        appended managed block to ${patchPath}`);
}

// ── 4. credentials + smoke tests + report ────────────────────────────────────
const credPath = join(dshHome, ".credentials.yaml");
let keyOk = false;
if (await exists(credPath)) keyOk = /^PERPLEXITY_API_KEY:\s*\S/m.test(await readFile(credPath, "utf8"));
if (!process.env.PERPLEXITY_API_KEY) keyOk = false; // env also satisfies

console.log("4/4 credentials  " + (keyOk
	? "PERPLEXITY_API_KEY present (credentials store or environment)"
	: "PERPLEXITY_API_KEY NOT FOUND — add it to .credentials.yaml, export it, or set a literal config.apiKey:"));
if (!keyOk) console.log(`     ${credPath}   (add: PERPLEXITY_API_KEY: pplx-...)`);

let tests = "skipped (no node?)";
try {
	execFileSync("node", ["test.mjs"], { cwd: pluginDir, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
	execFileSync("node", ["test-client.mjs"], { cwd: pluginDir, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
	tests = "both suites pass";
} catch (err) {
	const out = String(err.stdout ?? "") + String(err.stderr ?? "");
	if (/Cannot find package/.test(out)) tests = "FAILED — dsh-internal packages did not resolve (dsh version mismatch?)";
	else if (err.code === 127 || /ENOENT/.test(String(err.message))) tests = "skipped (node not found)";
	else tests = "FAILED (see below)";
	if (/FAILED/.test(tests)) console.log(out.split("\n").slice(-8).join("\n"));
}
console.log(`     smoke tests  ${tests}`);

console.log(`
Done. Next steps:
  1. Restart the dsh server in that environment (or start it).
  2. Open the GUI, refresh the page, Settings -> Plugins -> "Plugin configuration":
     the "Perplexity search" card should appear (Max retrieved length, Max results).
  3. Verify with a web_search from a new session — results should be Perplexity /search rows.
Uninstall later with:  node uninstall.mjs --dsh-home ${dshHome} --profile ${opts.profile}
`);
