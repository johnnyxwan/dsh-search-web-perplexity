# dsh-search-web-perplexity

Perplexity Search API provider (model-agnostic `POST /search`) for the DSH web
capability seam (`ctx.web`), plus a web settings card. Gives a DSH profile's
`web_search` tool Perplexity-backed retrieval instead of the bundled DeepSeek
search.

- **Provider id:** `dsh-search-web-perplexity`
- **Settings namespace:** `dsh-search-web-perplexity` (`maxRetrievedLength`, default `4096` bytes; over-limit rows are trimmed with a spill-file pointer in the tool context)
- **API key:** `PERPLEXITY_API_KEY` — from the DSH credentials store (GUI: *Settings → Credentials*), the process environment, or a literal `config.apiKey`

## Install (one command)

```sh
dsh plugin --profile web add git+https://github.com/johnnyxwan/dsh-search-web-perplexity.git
```

`dsh plugin` forwards to pnpm in the profile directory and then reconciles
`dsh.profile.bundles`: because this package declares `dsh.bundle.patch`
(`./cordis.patch.yml`), the launcher applies its bundle layer at boot, mounting
the `dsh-search-web-perplexity` provider entry. No build step is involved.

## Wire it up (profile's own `cordis.patch.yml`)

The bundle layer only mounts the provider entry. **Selecting** it is a
deployment choice, made in the profile's own `cordis.patch.yml`
(`~/.dsh/profiles/<profile>/cordis.patch.yml`, applied after every bundle
layer):

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: dsh-search-web-perplexity
    fetchProvider: <your fetch provider, if any>

# Optional: keep only this provider.
- id: web-search-deepseek
  disabled: true
```

Note: entry-patch overrides replace whole config keys, so the `id: web` row
must state every provider selection the profile wants in one place.

After editing, restart the DSH server (the host half loads at boot).

## Uninstall

```sh
dsh plugin --profile web remove dsh-search-web-perplexity
```

and remove the selection rows above from the profile's `cordis.patch.yml`.
Persisted settings under the `dsh-search-web-perplexity` namespace survive
uninstall.

## Layout

| file | role |
| --- | --- |
| `index.js` | host half: registers the search provider + settings section |
| `client.js` | browser half: the settings card (served at `/plugins/dsh-search-web-perplexity/client.js`) |
| `cordis.patch.yml` | the bundle layer (`dsh.bundle.patch`) |
| `test.mjs` / `test-client.mjs` | host / browser test suites (`node test.mjs`) |
| `dist/install.mjs` / `dist/uninstall.mjs` | legacy scripted installer for profiles not using `dsh plugin` — do not combine with the bundle route in the same profile (duplicate entry ids) |
