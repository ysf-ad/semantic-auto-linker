import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { NoteRecord, SemanticAutoLinkerSettings } from "./types";
import { normalizePathToLink, normalizeText, tokenize, uniqueStrings } from "./text-utils";

type AliasCache = {
	aliases?: string | string[];
	tags?: Array<{ tag: string }>;
};

export class VaultIndex {
	private app: App;
	private settings: SemanticAutoLinkerSettings;
	private notesByPath = new Map<string, NoteRecord>();
	private lookupMap = new Map<string, NoteRecord[]>();
	private rebuilding = false;

	constructor(app: App, settings: SemanticAutoLinkerSettings) {
		this.app = app;
		this.settings = settings;
	}

	updateSettings(settings: SemanticAutoLinkerSettings): void {
		this.settings = settings;
	}

	get size(): number {
		return this.notesByPath.size;
	}

	getAll(): NoteRecord[] {
		return [...this.notesByPath.values()];
	}

	getByPath(path: string): NoteRecord | null {
		return this.notesByPath.get(path) ?? null;
	}

	rebuild(): Promise<void> {
		if (this.rebuilding) {
			return Promise.resolve();
		}
		this.rebuilding = true;

		try {
			this.notesByPath.clear();
			this.lookupMap.clear();

			const files = this.app.vault.getMarkdownFiles().filter((file) => this.shouldInclude(file));
			for (const file of files) {
				this.insertRecord(this.buildRecord(file));
			}
		} finally {
			this.rebuilding = false;
		}
		return Promise.resolve();
	}

	refreshFile(file: TFile): Promise<void> {
		if (!this.shouldInclude(file)) {
			this.removeFile(file.path);
			return Promise.resolve();
		}
		this.removeFile(file.path);
		this.insertRecord(this.buildRecord(file));
		return Promise.resolve();
	}

	removeFile(path: string): void {
		const existing = this.notesByPath.get(path);
		if (!existing) {
			return;
		}

		this.notesByPath.delete(path);
		for (const key of existing.lookupKeys) {
			const values = this.lookupMap.get(key);
			if (!values) {
				continue;
			}
			const nextValues = values.filter((record) => record.path !== existing.path);
			if (nextValues.length === 0) {
				this.lookupMap.delete(key);
				continue;
			}
			this.lookupMap.set(key, nextValues);
		}
	}

	private insertRecord(record: NoteRecord): void {
		this.notesByPath.set(record.path, record);
		for (const key of record.lookupKeys) {
			const bucket = this.lookupMap.get(key) ?? [];
			bucket.push(record);
			this.lookupMap.set(key, bucket);
		}
	}

	private shouldInclude(file: TFile): boolean {
		if (this.settings.excludedFiles.includes(file.path)) {
			return false;
		}
		if (isGeneratedDrawingMarkdown(file.path)) {
			return false;
		}

		return !this.settings.excludedFolders.some((folder) =>
			file.path === folder || file.path.startsWith(folder.endsWith("/") ? folder : `${folder}/`),
		);
	}

	private buildRecord(file: TFile): NoteRecord {
		const cache = this.app.metadataCache.getFileCache(file) as AliasCache | null;
		const aliases = this.settings.enableAliasMatching ? parseAliases(cache?.aliases) : [];
		const tags = uniqueStrings((cache?.tags ?? []).map((tag) => tag.tag));
		const title = file.basename;
		const lookupKeys = uniqueStrings([title, ...aliases].map(normalizeText).filter(Boolean));

		return {
			file,
			path: file.path,
			linkTarget: normalizePathToLink(file.path),
			title,
			aliases,
			normalizedTitle: normalizeText(title),
			titleTokens: tokenize(title),
			lookupKeys,
			tags,
		};
	}
}

function parseAliases(aliases: string | string[] | undefined): string[] {
	if (!aliases) {
		return [];
	}
	if (Array.isArray(aliases)) {
		return uniqueStrings(aliases);
	}
	return uniqueStrings([aliases]);
}

export function isGeneratedDrawingMarkdown(path: string): boolean {
	const normalizedPath = path.toLowerCase();
	return normalizedPath.endsWith(".excalidraw.md")
		|| normalizedPath.includes("/excalidraw/")
		|| /(?:^|\/)drawing \d{4}-\d{2}-\d{2} .+\.md$/.test(normalizedPath)
		|| /(?:^|\/)drawing @\d{2}-\d{2}-\d{2}\.md$/.test(normalizedPath);
}
