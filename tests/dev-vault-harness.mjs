import fs from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const { analyzeNoteContent } = await jiti.import("../src/matcher.ts");
const { analyzeEntireVault } = await jiti.import("../src/vault-analysis.ts");
const { SemanticIndex } = await jiti.import("../src/semantic-index.ts");
const { SemanticProviderRegistry } = await jiti.import("../src/semantic-provider.ts");
const { normalizePathToLink, normalizeText, tokenize, uniqueStrings } = await jiti.import("../src/text-utils.ts");

export async function createDevVaultHarness() {
	const rootDir = path.resolve("dev-vault");
	const pluginDataPath = path.join(rootDir, ".obsidian", "plugins", "semantic-auto-linker", "data.json");
	const pluginData = await readPluginData(pluginDataPath);
	const settings = {
		...defaultSettings(),
		...(pluginData.settings ?? {}),
	};
	const markdownEntries = await collectMarkdownEntries(rootDir);
	const recordMap = new Map(markdownEntries.map((entry) => [entry.relativePath, entry.record]));
	const vaultIndex = {
		getAll() {
			return [...recordMap.values()];
		},
		get size() {
			return recordMap.size;
		},
	};
	const app = {
		vault: {
			async read(file) {
				return await fs.readFile(file.fullPath, "utf8");
			},
		},
	};

	const semanticIndex = new SemanticIndex(
		app,
		vaultIndex,
		new SemanticProviderRegistry(),
		settings,
		pluginData.semanticCache ?? {},
	);
	await semanticIndex.rebuild();

	return {
		rootDir,
		settings,
		recordMap,
		semanticIndex,
		async readNote(relativePath) {
			const entry = markdownEntries.find((item) => item.relativePath === relativePath);
			if (!entry) {
				throw new Error(`Missing dev-vault note: ${relativePath}`);
			}
			return await fs.readFile(entry.fullPath, "utf8");
		},
		analyzeNote: async (relativePath) => {
			const record = recordMap.get(relativePath);
			if (!record) {
				throw new Error(`Missing record for ${relativePath}`);
			}
			const source = await fs.readFile(path.join(rootDir, ...relativePath.split("/")), "utf8");
			return await analyzeNoteContent(record, source, vaultIndex, settings, semanticIndex);
		},
		analyzeWholeVault: async () => {
			return await analyzeEntireVault(
				vaultIndex,
				settings,
				semanticIndex,
				async (record) => await fs.readFile(record.file.fullPath, "utf8"),
			);
		},
	};
}

async function readPluginData(pluginDataPath) {
	try {
		return JSON.parse(await fs.readFile(pluginDataPath, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

async function collectMarkdownEntries(rootDir) {
	const files = await walk(rootDir);
	const markdownFiles = files
		.filter((file) => file.endsWith(".md"))
		.filter((file) => !file.includes(`${path.sep}.obsidian${path.sep}`));

	const entries = [];
	for (const fullPath of markdownFiles) {
		const relativePath = toVaultPath(path.relative(rootDir, fullPath));
		const source = await fs.readFile(fullPath, "utf8");
		const frontmatter = parseFrontmatter(source);
		const stat = await fs.stat(fullPath);
		const title = path.basename(fullPath, ".md");
		const aliases = uniqueStrings(frontmatter.aliases ?? []);
		const tags = uniqueStrings(frontmatter.tags ?? []);
		const file = {
			path: relativePath,
			fullPath,
			basename: title,
			extension: "md",
			stat: {
				mtime: stat.mtimeMs,
			},
		};
		entries.push({
			fullPath,
			relativePath,
			record: {
				file,
				path: relativePath,
				linkTarget: normalizePathToLink(relativePath),
				title,
				aliases,
				normalizedTitle: normalizeText(title),
				titleTokens: tokenize(title),
				lookupKeys: uniqueStrings([title, ...aliases].map(normalizeText).filter(Boolean)),
				tags,
			},
		});
	}

	return entries;
}

async function walk(rootDir) {
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const fullPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await walk(fullPath));
		} else {
			files.push(fullPath);
		}
	}
	return files;
}

function toVaultPath(value) {
	return value.split(path.sep).join("/");
}

function parseFrontmatter(source) {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) {
		return { aliases: [], tags: [] };
	}
	const lines = match[1].split(/\r?\n/);
	const result = {
		aliases: [],
		tags: [],
	};
	let currentKey = null;
	for (const line of lines) {
		const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (keyMatch) {
			currentKey = keyMatch[1];
			const rawValue = keyMatch[2].trim();
			if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
				const items = rawValue
					.slice(1, -1)
					.split(",")
					.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
					.filter(Boolean);
				assignFrontmatterValue(result, currentKey, items);
			} else if (rawValue) {
				assignFrontmatterValue(result, currentKey, [rawValue.replace(/^['"]|['"]$/g, "")]);
			}
			continue;
		}
		const listMatch = line.match(/^\s*-\s*(.+)$/);
		if (listMatch && currentKey) {
			assignFrontmatterValue(result, currentKey, [listMatch[1].trim().replace(/^['"]|['"]$/g, "")]);
		}
	}
	return result;
}

function assignFrontmatterValue(target, key, values) {
	if (key === "aliases") {
		target.aliases.push(...values);
	}
	if (key === "tags") {
		target.tags.push(...values.map((value) => value.startsWith("#") ? value : value));
	}
}

function defaultSettings() {
	return {
		firstOccurrenceOnly: true,
		maxLinksPerNote: 12,
		excludedFolders: [],
		excludedFiles: [],
		excludedTargetFiles: [],
		enableExactMatching: true,
		enableAliasMatching: true,
		enableSemanticSuggestions: true,
		skipHeadings: true,
		seeAlsoHeading: "See also",
		seeAlsoCount: 5,
		semanticMode: false,
		semanticProviderId: "ollama",
		semanticTopK: 8,
		semanticSummaryLength: 280,
		semanticTransformersModel: "Xenova/all-MiniLM-L6-v2",
		semanticTransformersDevice: "auto",
		semanticOllamaBaseUrl: "http://127.0.0.1:11434",
		semanticOllamaModel: "embeddinggemma",
		semanticProjectionMetric: "cosine",
		semanticExplorerLabelDistance: 620,
		semanticDisplayThreshold: 0.3,
		semanticAcceptanceThreshold: 0.6,
		autoRefreshEnabled: true,
		autoRefreshMinutes: 60,
	};
}
