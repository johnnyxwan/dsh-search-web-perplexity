#!/usr/bin/env node
/**
 * Removes the dsh-search-web-perplexity profile plugin from a DSH home.
 *
 * Usage:
 *   node uninstall.mjs [--dsh-home DIR] [--profile NAME] [--purge]
 *
 * Defaults: DSH_HOME env var or ~/.dsh; profile "web".
 *
 * Removes:
 *   - the managed entry block from <profile>/cordis.patch.yml (between the
 *     >>> / <<< marker comments; your other patch entries are untouched)
 *   - the profile-local node_modules symlink for the package
 *   - with --purge: the plugin files under <profile>/plugins/dsh-search-web-perplexity/
 *
 * Keeps the PERPLEXITY_API_KEY credential (delete it from
 * <dsh-home>/.credentials.yaml yourself if you want it gone — and rotate it
 * if this machine was ever untrusted).
 */
import { lstat, access, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const PKG_NAME = "dsh-search-web-perplexity";
const PLUGIN_DIRNAME = "dsh-search-web-perplexity";
const MARKER_HEAD = `# >>> ${PKG_NAME} (managed block — uninstall.mjs removes this) >>>`;
const MARKER_TAIL = `# <<< ${PKG_NAME} <<<`;

/** Escape regex metacharacters so the marker strings match literally. */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
const BLOCK_RE = new RegExp(`\\n?${escapeRegExp(MARKER_HEAD)}[\\s\\S]*?${escapeRegExp(MARKER_TAIL)}\\n?`);

function args() {
	const out = { dshHome: void 0, profile: "web", purge: false };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dsh-home") out.dshHome = argv[++i];
		else if (argv[i] === "--profile") out.profile = argv[++i];
		else if (argv[i] === "--purge") out.purge = true;
		else { console.error(`unknown flag: ${argv[i]}`); process.exit(2); }
	}
	return out;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

const opts = args();
const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", opts.profile);
const pluginDir = join(profileDir, "plugins", PLUGIN_DIRNAME);
const linkPath = join(profileDir, "node_modules", PKG_NAME);
const patchPath = join(profileDir, "cordis.patch.yml");
console.log(`DSH home: ${dshHome}  profile: ${opts.profile}`);

let touched = 0;

// 1. patch block
if (await exists(patchPath)) {
	const text = await readFile(patchPath, "utf8");
	if (!text.includes(MARKER_HEAD)) {
		console.log("patch:        no managed block found — cordis.patch.yml untouched");
	} else {
		const next = text.replace(BLOCK_RE, "\n").replace(/\n{3,}/g, "\n\n");
		await writeFile(patchPath, next);
		console.log(`patch:        removed managed block from ${patchPath}`);
		touched++;
	}
} else {
	console.log("patch:        cordis.patch.yml absent — nothing to do");
}

// 2. symlink
if (await exists(linkPath)) {
	const st = await lstat(linkPath);
	if (st.isSymbolicLink()) {
		const target = (await readFile(linkPath, "utf8")).trim();
		if (target.endsWith(join("plugins", PLUGIN_DIRNAME)) || target === pluginDir) {
			await rm(linkPath);
			console.log(`symlink:      removed ${linkPath}`);
			touched++;
		} else {
			console.log(`symlink:      ${linkPath} points elsewhere (${target}) — left alone`);
		}
	} else {
		console.log(`symlink:      ${linkPath} is not a symlink — left alone`);
	}
} else {
	console.log("symlink:      absent — nothing to do");
}

// 3. plugin files (only with --purge)
if (opts.purge && (await exists(pluginDir))) {
	await rm(pluginDir, { recursive: true, force: true });
	console.log(`plugin dir:   removed ${pluginDir}`);
	touched++;
} else if (!opts.purge) {
	console.log(`plugin dir:   kept ${pluginDir} (use --purge to delete the files)`);
}

console.log(`
Done${touched ? "" : " (nothing to remove)"}.
Reminder: the PERPLEXITY_API_KEY credential still sits in ${join(dshHome, ".credentials.yaml")}
if you added it there — remove that line (and rotate the key) if you want it gone.
If a dsh server is running in that environment, restart it to drop the plugin.`);
