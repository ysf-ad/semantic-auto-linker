# Semantic Auto-Linker

Semantic Auto-Linker is an Obsidian community plugin for safe, reviewable wiki-link insertion with optional local semantic retrieval.

It focuses on two things:
- safe inline linking with review before write
- vault-wide review with graph impact and semantic exploration

## Features

- Analyze the current note and review suggested inline `[[links]]`
- Analyze the whole vault and review suggestions before applying
- Switch insertion mode per review:
  - `Inline` updates matched text in place
  - `Footer` writes accepted targets into a footer section
- Strong safety rules:
  - skip frontmatter
  - skip fenced code and inline code
  - skip existing wikilinks and Markdown links
  - skip self-links
  - avoid duplicate link targets in the same note
- Deterministic matching for titles, aliases, normalization, and acronyms
- Optional semantic retrieval with a local Ollama embedding model
- Embedding explorer with PCA and t-SNE note/concept views
- Persistent whole-vault review state with background refresh when notes change

## Semantic mode

Semantic mode is optional and local-first.

Current provider support:
- Ollama

Typical setup:
1. Install and run [Ollama](https://ollama.com/).
2. Pull an embedding model, for example:
   - `ollama pull embeddinggemma`
3. In Obsidian, open **Settings → Community plugins → Semantic Auto-Linker**.
4. Enable **Semantic mode**.
5. Select the Ollama provider and model.
6. Run **Build semantic embeddings**.

## Privacy and network behavior

- The plugin is local/offline by default for deterministic linking.
- Semantic mode is opt-in.
- When semantic mode uses Ollama, the plugin sends note-derived text to the configured Ollama endpoint, which is typically `http://127.0.0.1:11434`.
- No telemetry or analytics are included.
- No cloud service is required.

## Commands

- `Open control panel`
- `Analyze current note for safe links`
- `Auto-link current selection`
- `Analyze whole vault for safe links`
- `Show embedding explorer`
- `Build or rebuild semantic index`
- `Build or rebuild note index`
- `Show related notes`

## Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

Semantic regression tests:

```bash
npm run test:semantic
```

Dev vault sync:

```bash
npm run build:dev-vault
```

## Manual install

Copy these files into:

```text
<Vault>/.obsidian/plugins/semantic-auto-linker/
```

Files:
- `main.js`
- `manifest.json`
- `styles.css`

Then reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Known limitations

- Semantic suggestions are still more conservative and less reliable than deterministic title/alias matches.
- Semantic quality depends heavily on the local embedding model.
- The plugin is currently desktop-only.

## Release

Marketplace release assets:
- `main.js`
- `manifest.json`
- `styles.css`

`manifest.json` and `versions.json` must be updated together for each release version.
