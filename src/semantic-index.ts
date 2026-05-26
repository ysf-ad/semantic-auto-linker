import type { App, TFile } from "obsidian";
import { HNSW } from "hnsw";
import type {
	NoteRecord,
	RelatedNoteSuggestion,
	SemanticAutoLinkerSettings,
	SemanticBuildProgress,
	SemanticCacheEntry,
	SemanticIndexStatus,
	SemanticNoteRecord,
	SemanticProjectionPoint,
	SemanticQueryMatch,
} from "./types";
import { SemanticProviderAvailability, SemanticProviderRegistry } from "./semantic-provider";
import { VaultIndex } from "./vault-index";
import { compactNormalizeText, normalizeText, tokenize } from "./text-utils";

const FRONTMATTER_REGEX = /^---[\s\S]*?\r?\n---\r?\n?/;
const FENCED_BLOCK_REGEX = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;
const WIKILINK_REGEX = /\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|([^[\]]+))?]]/g;
const MARKDOWN_LINK_REGEX = /!?\[([^[\]]+)]\([^)]+\)/g;
const HEADING_REGEX = /^\s{0,3}#{1,6}\s+/gm;
const DEFAULT_EMBEDDING_BATCH_SIZE = 8;
const SEMANTIC_READ_TIMEOUT_MS = 1_500;
const FALLBACK_GENERIC_TARGET_TERMS = [
	"file",
	"note",
	"page",
	"document",
	"item",
	"thing",
	"question",
	"answer",
	"look",
	"text",
	"textbook",
	"texbook",
	"lecture",
	"template",
	"source",
	"reference",
	"index",
	"map",
	"list",
];
const FALLBACK_STRUCTURAL_TARGET_PATTERNS = [
	"_Index*",
	"Index_*",
	"Notes @??-??-??",
	"????-??-??*",
	"lecture ????-??-??*",
	"Untitled*",
	"COMPILED NOTES*",
	"*lecture notes*",
	"templates/*",
];

interface SemanticRecordSearchMetadata {
	normalizedTitle: string;
	normalizedAliases: string[];
	titleTerms: Set<string>;
	aliasTerms: Set<string>;
	tagTerms: Set<string>;
	summaryTerms: Set<string>;
	summaryCounts: Map<string, number>;
	titleAcronym: string | null;
	aliasAcronyms: string[];
	normalizedTitleCompact: string;
	normalizedAliasesCompact: string[];
	compactPhrases: string[];
	canonicalBoost: number;
	targetPenalty: number;
}

const recordSearchMetadataCache = new WeakMap<SemanticNoteRecord, SemanticRecordSearchMetadata>();

export class SemanticIndex {
	private app: App;
	private vaultIndex: VaultIndex;
	private registry: SemanticProviderRegistry;
	private settings: SemanticAutoLinkerSettings;
	private cache: Record<string, SemanticCacheEntry>;
	private records = new Map<string, SemanticNoteRecord>();
	private lastBuiltAt: number | null = null;
	private lastProviderAvailability: SemanticProviderAvailability | null = null;
	private queryVectorCache = new Map<string, number[]>();
	private queryResultCache = new Map<string, SemanticQueryMatch[]>();
	private sparseResultCache = new Map<string, SemanticQueryMatch[]>();
	private annIndex: HNSW | null = null;
	private annPathById = new Map<number, string>();
	private searchableRecords: Array<{ record: SemanticNoteRecord; embedding: number[] }> = [];
	private searchableRecordByPath = new Map<string, { record: SemanticNoteRecord; embedding: number[] }>();
	private activeProviderId: string | null = null;

	constructor(
		app: App,
		vaultIndex: VaultIndex,
		registry: SemanticProviderRegistry,
		settings: SemanticAutoLinkerSettings,
		cache: Record<string, SemanticCacheEntry>,
	) {
		this.app = app;
		this.vaultIndex = vaultIndex;
		this.registry = registry;
		this.settings = settings;
		this.cache = cache;
	}

	updateSettings(settings: SemanticAutoLinkerSettings): void {
		if (settings.semanticProviderId !== this.settings.semanticProviderId) {
			this.activeProviderId = null;
		}
		this.settings = settings;
	}

	setCache(cache: Record<string, SemanticCacheEntry>): void {
		this.cache = cache;
	}

	async hydrateFromCache(): Promise<void> {
		const nextRecords = new Map<string, SemanticNoteRecord>();
		let latestCacheUpdate: number | null = null;

		for (const note of this.vaultIndex.getAll()) {
			const cached = this.cache[note.path];
			const cacheIsUsable = cached && isStoredCacheUsable(cached, note.file.stat.mtime);
			const record: SemanticNoteRecord = {
				path: note.path,
				title: note.title,
				aliases: note.aliases,
				tags: note.tags,
				summary: cacheIsUsable ? cached.summary : "",
				sourceText: cacheIsUsable ? cached.sourceText : "",
				mtime: note.file.stat.mtime,
				providerId: cacheIsUsable ? cached.providerId : null,
				modelId: cacheIsUsable ? cached.modelId : null,
				embedding: cacheIsUsable ? cached.embedding : null,
			};
			if (cacheIsUsable) {
				latestCacheUpdate = Math.max(latestCacheUpdate ?? 0, cached.updatedAt);
			}
			nextRecords.set(note.path, record);
		}

		this.records = nextRecords;
		this.activeProviderId = this.pickActiveProviderId(nextRecords, this.settings.semanticProviderId) ?? null;
		this.lastBuiltAt = latestCacheUpdate;
		this.lastProviderAvailability = this.activeProviderId
			? { available: true, reason: null }
			: this.lastProviderAvailability;
		this.queryVectorCache.clear();
		this.queryResultCache.clear();
		this.sparseResultCache.clear();
		if (this.activeProviderId) {
			await this.rebuildApproximateIndex(this.activeProviderId);
		} else {
			this.annIndex = null;
			this.annPathById.clear();
			this.searchableRecords = [];
		}
	}

	invalidateFile(path: string): void {
		this.records.delete(path);
		this.queryResultCache.clear();
		this.sparseResultCache.clear();
		this.searchableRecordByPath.delete(path);
	}

	async updateFileEmbedding(note: NoteRecord, file: TFile, source: string): Promise<boolean> {
		if (!this.settings.semanticMode) {
			return false;
		}

		const provider = this.getConfiguredProvider();
		const availability = await provider.checkAvailability(this.settings);
		this.lastProviderAvailability = availability;
		if (!availability.available) {
			return false;
		}

		const summary = summarizeNote(source, this.settings.semanticSummaryLength);
		const sourceText = buildSemanticSourceText(note, summary);
		const modelId = provider.getModelId(this.settings);
		const vectors = await this.embedBatchWithFallback(provider, modelId, [sourceText]);
		const vector = vectors?.embeddings[0];
		if (!vectors || !vector) {
			return false;
		}
		const activeProvider = vectors.provider;
		const activeModelId = vectors.modelId;
		const nextRecord: SemanticNoteRecord = {
			path: note.path,
			title: note.title,
			aliases: note.aliases,
			tags: note.tags,
			summary,
			sourceText,
			mtime: file.stat.mtime,
			providerId: activeProvider.id,
			modelId: activeModelId,
			embedding: vector,
		};

		this.records.set(note.path, nextRecord);
		this.queryVectorCache.clear();
		this.queryResultCache.clear();
		this.sparseResultCache.clear();
		this.searchableRecordByPath.delete(note.path);
		this.cache[note.path] = {
			path: note.path,
			providerId: activeProvider.id,
			modelId: activeModelId,
			mtime: file.stat.mtime,
			sourceText,
			summary,
			embedding: vector,
			updatedAt: Date.now(),
		};
		this.activeProviderId = activeProvider.id;
		await this.rebuildApproximateIndex(activeProvider.id);

		return true;
	}

	removeFile(path: string): void {
		this.records.delete(path);
		delete this.cache[path];
		this.queryResultCache.clear();
		this.sparseResultCache.clear();
		this.searchableRecordByPath.delete(path);
	}

	clearCache(): void {
		this.cache = {};
		this.records.clear();
		this.lastBuiltAt = null;
		this.lastProviderAvailability = null;
		this.queryVectorCache.clear();
		this.queryResultCache.clear();
		this.sparseResultCache.clear();
		this.annIndex = null;
		this.annPathById.clear();
		this.searchableRecords = [];
		this.searchableRecordByPath.clear();
	}

	async rebuild(onProgress?: (progress: SemanticBuildProgress) => void | Promise<void>): Promise<SemanticIndexStatus> {
		const provider = this.getConfiguredProvider();
		await notifyProgress(onProgress, {
			stage: "checking-provider",
			current: 0,
			total: 1,
			message: `Checking ${provider.label} availability...`,
		});
		const availability = this.settings.semanticMode
			? await provider.checkAvailability(this.settings)
			: {
				available: false,
				reason: "Semantic mode is disabled.",
		};
		const providerAvailable = availability.available;
		let effectiveAvailability = availability;
		const modelId = provider.getModelId(this.settings);
		const notes = this.vaultIndex.getAll();
		const nextRecords = new Map<string, SemanticNoteRecord>();
		const notesToEmbed: Array<{ note: NoteRecord; record: SemanticNoteRecord }> = [];
		let preparedCount = 0;

		for (const note of notes) {
			const cached = this.cache[note.path];
			const cachedIsReusable = providerAvailable && cached && isCacheMetadataFresh(cached, note.file.stat.mtime, provider.id, modelId);
			const source = cachedIsReusable ? null : await this.readFileForSemanticIndex(note.file);
			const summary = cachedIsReusable ? cached.summary : summarizeNote(source ?? "", this.settings.semanticSummaryLength);
			const sourceText = cachedIsReusable ? cached.sourceText : buildSemanticSourceText(note, summary);

			const record: SemanticNoteRecord = {
				path: note.path,
				title: note.title,
				aliases: note.aliases,
				tags: note.tags,
				summary,
				sourceText,
				mtime: note.file.stat.mtime,
				providerId: null,
				modelId: null,
				embedding: null,
			};

			if (cachedIsReusable && cached.embedding) {
				record.providerId = cached.providerId;
				record.modelId = cached.modelId;
				record.embedding = cached.embedding;
			} else if (providerAvailable && cached && isCacheFresh(cached, note.file.stat.mtime, provider.id, modelId, sourceText)) {
				record.providerId = cached.providerId;
				record.modelId = cached.modelId;
				record.embedding = cached.embedding;
			} else if (providerAvailable) {
				notesToEmbed.push({ note, record });
			}

			nextRecords.set(note.path, record);
			preparedCount += 1;
			await notifyProgress(onProgress, {
				stage: "preparing-notes",
				current: preparedCount,
				total: notes.length,
				message: `Preparing semantic note summaries (${preparedCount}/${notes.length})`,
			});
		}

		if (providerAvailable && notesToEmbed.length > 0) {
			let embeddedCount = 0;
			let activeProvider = provider;
			let activeModelId = modelId;
			let batchSize = getEmbeddingBatchSize(activeProvider.id, this.settings, notesToEmbed.length);
			let start = 0;
			while (start < notesToEmbed.length) {
				const batch = notesToEmbed.slice(start, start + batchSize);
				await notifyProgress(onProgress, {
					stage: "embedding",
					current: embeddedCount,
					total: notesToEmbed.length,
					message: `Generating embeddings (${embeddedCount}/${notesToEmbed.length})`,
				});
				const texts = batch.map((item) => item.record.sourceText);
				const vectors = await this.embedBatchWithFallback(activeProvider, activeModelId, texts);
				if (!vectors) {
					effectiveAvailability = this.lastProviderAvailability ?? {
						available: false,
						reason: `${activeProvider.label} embedding failed.`,
					};
					break;
				}
				activeProvider = vectors.provider;
				activeModelId = vectors.modelId;
				batchSize = getEmbeddingBatchSize(activeProvider.id, this.settings, notesToEmbed.length);

				vectors.embeddings.forEach((vector, index) => {
					const target = batch[index];
					if (!target) {
						return;
					}
					target.record.providerId = activeProvider.id;
					target.record.modelId = activeModelId;
					target.record.embedding = vector;
					this.cache[target.note.path] = {
						path: target.note.path,
						providerId: activeProvider.id,
						modelId: activeModelId,
						mtime: target.note.file.stat.mtime,
						sourceText: target.record.sourceText,
						summary: target.record.summary,
						embedding: vector,
						updatedAt: Date.now(),
					};
				});
				effectiveAvailability = { available: true, reason: null };
				embeddedCount += batch.length;
				start += batch.length;
				await notifyProgress(onProgress, {
					stage: "embedding",
					current: embeddedCount,
					total: notesToEmbed.length,
					message: `Generating embeddings with ${activeProvider.label} (${embeddedCount}/${notesToEmbed.length})`,
				});
			}
		}

		for (const path of Object.keys(this.cache)) {
			if (!nextRecords.has(path)) {
				delete this.cache[path];
			}
		}

		this.records = nextRecords;
		this.lastBuiltAt = Date.now();
		this.activeProviderId = this.pickActiveProviderId(nextRecords, provider.id) ?? provider.id;
		this.lastProviderAvailability = effectiveAvailability;
		this.queryVectorCache.clear();
		this.queryResultCache.clear();
		this.sparseResultCache.clear();
		await this.rebuildApproximateIndex(this.activeProviderId);
		await notifyProgress(onProgress, {
			stage: "complete",
			current: effectiveAvailability.available ? notes.length : 0,
			total: notes.length,
			message: effectiveAvailability.available
				? `Semantic index ready for ${notes.length} notes.`
				: effectiveAvailability.reason ?? "Semantic index unavailable.",
		});
		return this.getStatus();
	}

	getStatus(): SemanticIndexStatus {
		const provider = this.getActiveProvider();
		const records = [...this.records.values()];
		const cachedRecords = records.filter((record) => record.embedding && record.providerId === provider.id);
		const vectorDimensions = cachedRecords[0]?.embedding?.length ?? null;
		const availability = this.settings.semanticMode
			? this.lastProviderAvailability ?? {
				available: false,
				reason: "Semantic index has not been built yet.",
			}
			: {
				available: false,
				reason: "Semantic mode is disabled.",
			};

		return {
			providerId: provider.id,
			providerLabel: provider.label,
			available: availability.available,
			reason: availability.reason,
			noteCount: this.vaultIndex.size,
			cachedCount: cachedRecords.length,
			pendingCount: availability.available ? Math.max(0, this.vaultIndex.size - cachedRecords.length) : this.vaultIndex.size,
			vectorDimensions,
			lastBuiltAt: this.lastBuiltAt,
		};
	}

	async findRelatedNotesForPath(currentPath: string, linkedTargets: Set<string>, limit: number): Promise<RelatedNoteSuggestion[]> {
		if (!this.settings.semanticMode || limit <= 0) {
			return [];
		}

		const current = this.records.get(currentPath);
		if (!current) {
			return [];
		}

		const provider = this.registry.getById(this.settings.semanticProviderId);
		const availability = this.lastProviderAvailability?.available
			? this.lastProviderAvailability
			: await provider.checkAvailability(this.settings);
		if (!availability.available) {
			this.lastProviderAvailability = availability;
			return [];
		}
		this.lastProviderAvailability = availability;

		const providerId = provider.id;
		const modelId = provider.getModelId(this.settings);
		const queryVector = current.embedding
			?? await this.getOrCreateQueryVector(provider, providerId, modelId, current.sourceText);
		if (!queryVector) {
			return [];
		}

		const matches = this.searchRelatedRecords(current.title, queryVector, currentPath, linkedTargets, providerId, limit);

		return matches
			.slice(0, limit)
			.map((match) => ({
				targetPath: match.targetPath,
				targetTitle: match.targetTitle,
				targetLink: match.targetLink,
				reason: "semantic nearest neighbor",
				score: Number(match.score.toFixed(3)),
				previewText: this.records.get(match.targetPath)?.summary ?? "",
				accepted: match.score >= 0.58,
				matchType: "semantic" as const,
			}));
	}

	async buildProjection(
		dimensions: 2 | 3 = 2,
		scope: "notes" | "concepts" = "notes",
	): Promise<SemanticProjectionPoint[]> {
		const provider = this.getActiveProvider();
		const availability = this.lastProviderAvailability?.available
			? this.lastProviderAvailability
			: await provider.checkAvailability(this.settings);
		if (!availability.available) {
			this.lastProviderAvailability = availability;
			return [];
		}
		this.lastProviderAvailability = availability;

		const providerId = provider.id;
		const modelId = provider.getModelId(this.settings);
		const projectable = scope === "concepts"
			? await this.buildConceptProjectionRecords(provider, providerId, modelId)
			: [...this.records.values()]
				.filter((record) => record.embedding && record.embedding.length > 0)
				.map((record) => ({
					id: record.path,
					path: record.path,
					title: record.title,
					parentTitle: record.title,
					kind: "note" as const,
					tags: record.tags,
					region: deriveRegion(record.path),
					embedding: prepareProjectionVector(record.embedding as number[], this.settings.semanticProjectionMetric),
				}));

		if (projectable.length < 2) {
			return [];
		}

		const { PCA } = await import("ml-pca");
		const pca = new PCA(projectable.map((item) => item.embedding), {
			center: true,
			scale: false,
		});
		const output = pca.predict(projectable.map((item) => item.embedding), { nComponents: dimensions }).to2DArray();
		return normalizeProjection(output, projectable);
	}

	async findSimilarNotes(
		queries: string[],
		currentPath: string,
		limit: number,
		allowedTargetPaths?: Set<string>,
	): Promise<Map<string, SemanticQueryMatch[]>> {
		const result = new Map<string, SemanticQueryMatch[]>();
		const trimmedQueries = queries.map((query) => query.trim()).filter(Boolean);
		if (!this.settings.semanticMode || trimmedQueries.length === 0) {
			return result;
		}

		const provider = this.getActiveProvider();
		const availability = this.lastProviderAvailability?.available
			? this.lastProviderAvailability
			: await provider.checkAvailability(this.settings);
		if (!availability.available) {
			this.lastProviderAvailability = availability;
			return result;
		}
		this.lastProviderAvailability = availability;

		const providerId = provider.id;
		const modelId = provider.getModelId(this.settings);
		if (this.searchableRecords.length === 0) {
			return result;
		}
		await this.populateQueryVectors(provider, providerId, modelId, trimmedQueries);
		const scopedRecords = allowedTargetPaths && allowedTargetPaths.size > 0 && allowedTargetPaths.size <= 128
			? Array.from(allowedTargetPaths)
				.map((path) => this.searchableRecordByPath.get(path))
				.filter((entry): entry is { record: SemanticNoteRecord; embedding: number[] } => Boolean(entry))
			: null;

		for (const query of trimmedQueries) {
			const queryVector = this.queryVectorCache.get(buildQueryVectorCacheKey(providerId, modelId, query));
			if (!queryVector) {
				continue;
			}
			const expandedLimit = Math.min(this.searchableRecords.length, Math.max(limit * 4, 24));
			let cachedMatches: SemanticQueryMatch[];
			if (scopedRecords) {
				cachedMatches = searchBruteForce(query, queryVector, scopedRecords, Math.min(scopedRecords.length, expandedLimit));
			} else {
				const resultKey = buildQueryResultCacheKey(providerId, modelId, query, expandedLimit);
				cachedMatches = this.queryResultCache.get(resultKey) ?? [];
				if (cachedMatches.length === 0) {
					cachedMatches = this.annIndex
						? this.searchApproximate(query, queryVector, this.searchableRecords, expandedLimit)
						: searchBruteForce(query, queryVector, this.searchableRecords, expandedLimit);
					this.queryResultCache.set(resultKey, cachedMatches);
				}
			}
			result.set(
				query,
				cachedMatches
					.filter((match) => !this.isExcludedTarget(match.targetPath))
					.filter((match) => !allowedTargetPaths || allowedTargetPaths.has(match.targetPath))
					.filter((match) => match.targetPath !== currentPath)
					.slice(0, Math.max(1, limit)),
			);
		}

		return result;
	}

	async findHybridSimilarNotes(query: string, currentPath: string, limit: number, allowedTargetPaths?: Set<string>): Promise<SemanticQueryMatch[]> {
		const normalizedQuery = query.trim();
		if (!this.settings.semanticMode || !normalizedQuery) {
			return [];
		}

		const baseLimit = Math.max(limit, 8);
		const expandedLimit = getExpandedHybridLimit(baseLimit);
		const denseMatchesByQuery = await this.findSimilarNotes([normalizedQuery], currentPath, baseLimit, allowedTargetPaths);
		const denseMatches = denseMatchesByQuery.get(normalizedQuery) ?? [];
		const sparseMatches = this.searchSparse(normalizedQuery, expandedLimit, allowedTargetPaths);

		const merged = new Map<string, SemanticQueryMatch>();
		for (const match of sparseMatches) {
			if (match.targetPath === currentPath || this.isExcludedTarget(match.targetPath)) {
				continue;
			}
			merged.set(match.targetPath, { ...match });
		}
		for (const match of denseMatches) {
			if (match.targetPath === currentPath || this.isExcludedTarget(match.targetPath)) {
				continue;
			}
			const current = merged.get(match.targetPath);
			if (!current) {
				merged.set(match.targetPath, { ...match });
				continue;
			}
			current.score = Math.max(current.score, match.score) + 0.04;
			merged.set(match.targetPath, current);
		}

		return this.rerankHybridMatches(normalizedQuery, currentPath, [...merged.values()])
			.sort((left, right) => right.score - left.score)
			.filter((match) => match.score >= getHybridNoLinkFloor(normalizedQuery, match, this.settings))
			.slice(0, Math.max(1, limit));
	}

	async prewarmSimilarQueries(queries: string[], limit: number): Promise<void> {
		const trimmedQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
		if (!this.settings.semanticMode || trimmedQueries.length === 0) {
			return;
		}

		const provider = this.getActiveProvider();
		const availability = this.lastProviderAvailability?.available
			? this.lastProviderAvailability
			: await provider.checkAvailability(this.settings);
		if (!availability.available) {
			this.lastProviderAvailability = availability;
			return;
		}
		this.lastProviderAvailability = availability;

		const providerId = provider.id;
		const modelId = provider.getModelId(this.settings);
		if (this.searchableRecords.length === 0) {
			return;
		}
		await this.populateQueryVectors(provider, providerId, modelId, trimmedQueries);

		for (const query of trimmedQueries) {
			const queryVector = this.queryVectorCache.get(buildQueryVectorCacheKey(providerId, modelId, query));
			if (!queryVector) {
				continue;
			}
			const expandedLimit = Math.min(this.searchableRecords.length, Math.max(limit * 4, 24));
			const resultKey = buildQueryResultCacheKey(providerId, modelId, query, expandedLimit);
			if (this.queryResultCache.has(resultKey)) {
				continue;
			}
			const matches = this.annIndex
				? this.searchApproximate(query, queryVector, this.searchableRecords, expandedLimit)
				: searchBruteForce(query, queryVector, this.searchableRecords, expandedLimit);
			this.queryResultCache.set(resultKey, matches);
		}
	}

	async prewarmQueryVectors(queries: string[]): Promise<void> {
		const trimmedQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
		if (!this.settings.semanticMode || trimmedQueries.length === 0) {
			return;
		}

		const provider = this.getActiveProvider();
		const availability = this.lastProviderAvailability?.available
			? this.lastProviderAvailability
			: await provider.checkAvailability(this.settings);
		if (!availability.available) {
			this.lastProviderAvailability = availability;
			return;
		}
		this.lastProviderAvailability = availability;

		const providerId = provider.id;
		const modelId = provider.getModelId(this.settings);
		for (let index = 0; index < trimmedQueries.length; index += 128) {
			await this.populateQueryVectors(provider, providerId, modelId, trimmedQueries.slice(index, index + 128));
		}
	}

	private async buildConceptProjectionRecords(
		provider: ReturnType<SemanticProviderRegistry["getById"]>,
		providerId: string,
		modelId: string,
	): Promise<Array<{ id: string; path: string; title: string; parentTitle: string; kind: "concept"; tags: string[]; region: string; embedding: number[] }>> {
		const conceptTexts = [...this.records.values()]
			.flatMap((record) => {
				const labels = uniqueConceptLabels(record);
				return labels.map((label, index) => ({
					id: `${record.path}::concept::${index}`,
					path: record.path,
					title: label,
					parentTitle: record.title,
					tags: record.tags,
					region: deriveRegion(record.path),
					text: label,
				}));
			})
			.filter((entry) => entry.text.length > 0);

		await this.populateQueryVectors(
			provider,
			providerId,
			modelId,
			conceptTexts.map((entry) => entry.text),
		);

		return conceptTexts
			.map((entry) => ({
				id: entry.id,
				path: entry.path,
				title: entry.title,
				parentTitle: entry.parentTitle,
				kind: "concept" as const,
				tags: entry.tags,
				region: entry.region,
				embedding: prepareProjectionVector(
					this.queryVectorCache.get(buildQueryVectorCacheKey(providerId, modelId, entry.text)) ?? [],
					this.settings.semanticProjectionMetric,
				),
			}))
			.filter((entry) => Array.isArray(entry.embedding) && entry.embedding.length > 0);
	}

	private async populateQueryVectors(
		provider: ReturnType<SemanticProviderRegistry["getById"]>,
		providerId: string,
		modelId: string,
		queries: string[],
	): Promise<void> {
		const queriesToEmbed: string[] = [];
		for (const query of queries) {
			const vectorKey = buildQueryVectorCacheKey(providerId, modelId, query);
			if (!this.queryVectorCache.has(vectorKey)) {
				queriesToEmbed.push(query);
			}
		}

		if (queriesToEmbed.length === 0) {
			return;
		}

		const newVectors = await this.embedBatchSafely(provider, providerId, modelId, queriesToEmbed);
		if (!newVectors) {
			return;
		}
		newVectors.forEach((vector, index) => {
			const query = queriesToEmbed[index];
			if (!query) {
				return;
			}
			this.queryVectorCache.set(buildQueryVectorCacheKey(providerId, modelId, query), vector);
		});
	}

	private async getOrCreateQueryVector(
		provider: ReturnType<SemanticProviderRegistry["getById"]>,
		providerId: string,
		modelId: string,
		query: string,
	): Promise<number[] | null> {
		await this.populateQueryVectors(provider, providerId, modelId, [query]);
		return this.queryVectorCache.get(buildQueryVectorCacheKey(providerId, modelId, query)) ?? null;
	}

	private async embedBatchSafely(
		provider: ReturnType<SemanticProviderRegistry["getById"]>,
		providerId: string,
		modelId: string,
		texts: string[],
	): Promise<number[][] | null> {
		try {
			return provider.embedBatch
				? await provider.embedBatch(texts, this.settings)
				: await Promise.all(texts.map((text) => provider.embed(text, this.settings)));
		} catch (error) {
			this.markProviderRuntimeFailure(providerId, modelId, error);
			return null;
		}
	}

	private async embedBatchWithFallback(
		provider: ReturnType<SemanticProviderRegistry["getById"]>,
		modelId: string,
		texts: string[],
	): Promise<{ provider: ReturnType<SemanticProviderRegistry["getById"]>; modelId: string; embeddings: number[][] } | null> {
		const embeddings = await this.embedBatchSafely(provider, provider.id, modelId, texts);
		if (embeddings) {
			return { provider, modelId, embeddings };
		}
		for (const fallbackProvider of this.getEmbeddingFallbackProviders(provider.id)) {
			const availability = await fallbackProvider.checkAvailability(this.settings);
			if (!availability.available) {
				continue;
			}
			const fallbackModelId = fallbackProvider.getModelId(this.settings);
			const fallbackEmbeddings = await this.embedBatchSafely(fallbackProvider, fallbackProvider.id, fallbackModelId, texts);
			if (!fallbackEmbeddings) {
				continue;
			}
			return {
				provider: fallbackProvider,
				modelId: fallbackModelId,
				embeddings: fallbackEmbeddings,
			};
		}
		return null;
	}

	private getEmbeddingFallbackProviders(providerId: string): Array<ReturnType<SemanticProviderRegistry["getById"]>> {
		const fallbackIds = providerId === "ollama"
			? ["local-fallback"]
			: ["local-fallback", "ollama"];
		return fallbackIds
			.map((id) => this.registry.getById(id))
			.filter((provider) => provider.id !== providerId);
	}

	private getActiveProvider(): ReturnType<SemanticProviderRegistry["getById"]> {
		return this.registry.getById(this.activeProviderId ?? this.settings.semanticProviderId);
	}

	private getConfiguredProvider(): ReturnType<SemanticProviderRegistry["getById"]> {
		return this.registry.getById(this.settings.semanticProviderId);
	}

	private pickActiveProviderId(records: Map<string, SemanticNoteRecord>, preferredProviderId?: string): string | null {
		const counts = new Map<string, number>();
		for (const record of records.values()) {
			if (!record.providerId || !record.embedding) {
				continue;
			}
			counts.set(record.providerId, (counts.get(record.providerId) ?? 0) + 1);
		}
		if (preferredProviderId && (counts.get(preferredProviderId) ?? 0) > 0) {
			return preferredProviderId;
		}
		return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
	}

	private markProviderRuntimeFailure(providerId: string, modelId: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.lastProviderAvailability = {
			available: false,
			reason: `${providerId} embedding failed for ${modelId}: ${message}`,
		};
	}

	private async readFileForSemanticIndex(file: TFile): Promise<string | null> {
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const readFile = this.app.vault.cachedRead
			? this.app.vault.cachedRead(file)
			: this.app.vault.read(file);
		try {
			return await Promise.race([
				readFile,
				new Promise<null>((resolve) => {
					timeoutId = setTimeout(() => resolve(null), SEMANTIC_READ_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timeoutId !== null) {
				clearTimeout(timeoutId);
			}
		}
	}

	private rerankHybridMatches(query: string, currentPath: string, matches: SemanticQueryMatch[]): SemanticQueryMatch[] {
		const sourceRecord = this.records.get(currentPath) ?? null;
		return matches.map((match) => {
			const targetRecord = this.records.get(match.targetPath) ?? null;
			if (!targetRecord) {
				return match;
			}
			const score = match.score
				+ contextualTargetBoost(query, sourceRecord, targetRecord)
				- genericTargetPenalty(query, sourceRecord, targetRecord, this.settings);
			return {
				...match,
				score: Math.max(0, Number(score.toFixed(4))),
			};
		});
	}

	private async rebuildApproximateIndex(providerId: string): Promise<void> {
		const records = [...this.records.values()]
			.filter((record) => record.providerId === providerId && record.embedding)
			.map((record) => ({
				record,
				embedding: record.embedding as number[],
			}));
		this.searchableRecords = records;
		this.searchableRecordByPath = new Map(records.map((entry) => [entry.record.path, entry]));
		if (records.length === 0) {
			this.annIndex = null;
			this.annPathById.clear();
			this.searchableRecordByPath.clear();
			return;
		}

		const dimension = records[0]?.embedding.length ?? null;
		if (!dimension) {
			this.annIndex = null;
			this.annPathById.clear();
			this.searchableRecordByPath.clear();
			return;
		}

		try {
			const index = new HNSW(16, 200, dimension, "cosine", 64);
			const annPathById = new Map<number, string>();
			await index.buildIndex(records.map(({ record, embedding }, id) => {
				annPathById.set(id, record.path);
				return {
					id,
					vector: embedding,
				};
			}));
			this.annPathById = annPathById;
			this.annIndex = index;
		} catch {
			this.annIndex = null;
			this.annPathById.clear();
		}
	}

	private searchApproximate(
		query: string,
		queryVector: number[],
		scoredRecords: Array<{ record: SemanticNoteRecord; embedding: number[] }>,
		limit: number,
	): SemanticQueryMatch[] {
		if (!this.annIndex) {
			return searchBruteForce(query, queryVector, scoredRecords, limit);
		}

		const recordByPath = new Map(scoredRecords.map(({ record }) => [record.path, record]));
		let approximate: Array<{ id: number }> = [];
		try {
			approximate = this.annIndex.searchKNN(queryVector, Math.min(scoredRecords.length, Math.max(limit, 12)));
		} catch {
			this.annIndex = null;
			this.annPathById.clear();
			return searchBruteForce(query, queryVector, scoredRecords, limit);
		}
		const matches = approximate
			.map((item) => {
				const path = this.annPathById.get(item.id);
				if (!path) {
					return null;
				}
				const record = recordByPath.get(path);
				if (!record || !record.embedding) {
					return null;
				}
				return {
					query,
					targetPath: record.path,
					targetTitle: record.title,
					targetLink: record.path.replace(/\.md$/i, ""),
					score: scoreSemanticMatch(query, record, queryVector, record.embedding),
				};
			})
			.filter((match): match is SemanticQueryMatch => Boolean(match))
			.sort((left, right) => right.score - left.score)
			.slice(0, Math.max(1, limit));

		return matches;
	}

	private searchRelatedRecords(
		query: string,
		queryVector: number[],
		currentPath: string,
		linkedTargets: Set<string>,
		providerId: string,
		limit: number,
	): SemanticQueryMatch[] {
		if (this.annIndex) {
			const matches: SemanticQueryMatch[] = [];
			const overfetch = Math.min(this.searchableRecords.length, Math.max(limit * 6, 48));
			let approximate: Array<{ id: number }> = [];
			try {
				approximate = this.annIndex.searchKNN(queryVector, overfetch);
			} catch {
				this.annIndex = null;
				this.annPathById.clear();
			}
			for (const item of approximate) {
				const path = this.annPathById.get(item.id);
				const entry = path ? this.searchableRecordByPath.get(path) : null;
				if (!entry || !this.isRelatedTargetAllowed(entry.record, currentPath, linkedTargets, providerId)) {
					continue;
				}
				matches.push({
					query,
					targetPath: entry.record.path,
					targetTitle: entry.record.title,
					targetLink: entry.record.path.replace(/\.md$/i, ""),
					score: scoreSemanticMatch(query, entry.record, queryVector, entry.embedding),
				});
				if (matches.length >= limit) {
					break;
				}
			}
			if (matches.length >= limit || this.annIndex) {
				return matches.sort((left, right) => right.score - left.score).slice(0, Math.max(1, limit));
			}
		}

		const scoredRecords = this.searchableRecords.filter(({ record }) =>
			this.isRelatedTargetAllowed(record, currentPath, linkedTargets, providerId),
		);
		return searchBruteForce(query, queryVector, scoredRecords, limit);
	}

	private isRelatedTargetAllowed(record: SemanticNoteRecord, currentPath: string, linkedTargets: Set<string>, providerId: string): boolean {
		return record.path !== currentPath
			&& record.providerId === providerId
			&& Boolean(record.embedding)
			&& !this.isExcludedTarget(record.path)
			&& !linkedTargets.has(record.path)
			&& !linkedTargets.has(record.path.replace(/\.md$/i, ""))
			&& !linkedTargets.has(record.title);
	}

	private searchSparse(query: string, limit: number, allowedTargetPaths?: Set<string>): SemanticQueryMatch[] {
		const queryTerms = tokenize(query);
		if (queryTerms.length === 0) {
			return [];
		}

		const scoped = allowedTargetPaths && allowedTargetPaths.size > 0 && allowedTargetPaths.size <= 128;
		const resultKey = scoped ? "" : buildSparseResultCacheKey(query, limit);
		const cached = this.sparseResultCache.get(resultKey);
		if (!scoped && cached) {
			return cached;
		}

		const records = scoped
			? Array.from(allowedTargetPaths ?? [])
				.map((path) => this.records.get(path))
				.filter((record): record is SemanticNoteRecord => Boolean(record))
			: [...this.records.values()];
		const matches = records
			.filter((record) => !this.isExcludedTarget(record.path))
			.map((record) => ({
				record,
				score: sparseScore(queryTerms, record),
			}))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score)
			.slice(0, Math.max(1, limit))
			.map(({ record, score }) => ({
				query,
				targetPath: record.path,
				targetTitle: record.title,
				targetLink: record.path.replace(/\.md$/i, ""),
				score,
			}));
		if (!scoped) {
			this.sparseResultCache.set(resultKey, matches);
		}
		return matches;
	}

	private isExcludedTarget(path: string): boolean {
		if ((this.settings.excludedTargetFiles ?? []).includes(path)) {
			return true;
		}
		const record = this.records.get(path);
		const title = record?.title ?? path.replace(/\.md$/i, "").split("/").pop() ?? path;
		return matchesAnyStructuralPattern(title, path, this.settings.excludedTargetPatterns ?? []);
	}
}

function searchBruteForce(
	query: string,
	queryVector: number[],
	scoredRecords: Array<{ record: SemanticNoteRecord; embedding: number[] }>,
	limit: number,
): SemanticQueryMatch[] {
	return scoredRecords
		.map(({ record, embedding }) => ({
			query,
			targetPath: record.path,
			targetTitle: record.title,
			targetLink: record.path.replace(/\.md$/i, ""),
			score: scoreSemanticMatch(query, record, queryVector, embedding),
		}))
		.filter((match) => Number.isFinite(match.score))
		.sort((left, right) => right.score - left.score)
		.slice(0, Math.max(1, limit));
}

function getRecordSearchMetadata(record: SemanticNoteRecord): SemanticRecordSearchMetadata {
	const cached = recordSearchMetadataCache.get(record);
	if (cached) {
		return cached;
	}

	const summaryCounts = new Map<string, number>();
	for (const term of tokenize(record.summary)) {
		summaryCounts.set(term, (summaryCounts.get(term) ?? 0) + 1);
	}
	const normalizedTitle = normalizeText(record.title);
	const normalizedAliases = record.aliases.map(normalizeText);
	const metadata: SemanticRecordSearchMetadata = {
		normalizedTitle,
		normalizedAliases,
		titleTerms: new Set(tokenize(record.title)),
		aliasTerms: new Set(record.aliases.flatMap((alias) => tokenize(alias))),
		tagTerms: new Set(record.tags.flatMap((tag) => tokenize(tag))),
		summaryTerms: new Set(summaryCounts.keys()),
		summaryCounts,
		titleAcronym: buildPhraseAcronym(record.title),
		aliasAcronyms: record.aliases
			.map((alias) => buildPhraseAcronym(alias))
			.filter((value): value is string => Boolean(value)),
		normalizedTitleCompact: normalizedTitle.replace(/\s+/g, ""),
		normalizedAliasesCompact: normalizedAliases.map((alias) => alias.replace(/\s+/g, "")),
		compactPhrases: [record.title, ...record.aliases]
			.map((phrase) => compactNormalizeText(phrase))
			.filter((phrase) => phrase.length >= 4),
		canonicalBoost: canonicalTargetBoost(record),
		targetPenalty: targetPenalty(record),
	};
	recordSearchMetadataCache.set(record, metadata);
	return metadata;
}

function scoreSemanticMatch(query: string, record: SemanticNoteRecord, queryVector: number[], embedding: number[]): number {
	const baseScore = cosineSimilarity(queryVector, embedding);
	const metadata = getRecordSearchMetadata(record);
	const normalizedQuery = normalizeText(query);
	const queryTerms = new Set(normalizedQuery.split(" ").filter(Boolean));

	let lexicalOverlap = 0;
	for (const term of queryTerms) {
		if (metadata.titleTerms.has(term)) {
			lexicalOverlap += 1;
		}
	}
	const titleOverlapBoost = queryTerms.size > 0 ? (lexicalOverlap / queryTerms.size) * 0.12 : 0;
	const aliasOverlapBoost = overlapRatio(queryTerms, metadata.aliasTerms) * 0.12;
	const summaryOverlapBoost = overlapRatio(queryTerms, metadata.summaryTerms) * 0.04;
	const tagOverlapBoost = overlapRatio(queryTerms, metadata.tagTerms) * 0.02;
	const exactSingleTermBoost = exactSingleTermSemanticBoost(queryTerms, metadata.titleTerms, metadata.aliasTerms, metadata.tagTerms);
	const acronymBoost = acronymSemanticBoost(normalizedQuery, record);
	const fuzzyBoost = fuzzyPhraseBoost(query, record);
	return baseScore + titleOverlapBoost + aliasOverlapBoost + summaryOverlapBoost + tagOverlapBoost + exactSingleTermBoost + acronymBoost + fuzzyBoost + metadata.canonicalBoost - metadata.targetPenalty;
}

function contextualTargetBoost(
	query: string,
	sourceRecord: SemanticNoteRecord | null,
	targetRecord: SemanticNoteRecord,
): number {
	let boost = 0;
	const normalizedQuery = normalizeText(query);
	const normalizedTitle = normalizeText(targetRecord.title);
	const normalizedAliases = targetRecord.aliases.map(normalizeText);

	if (normalizedTitle === normalizedQuery || normalizedAliases.includes(normalizedQuery)) {
		boost += 0.08;
	}
	if (sourceRecord && sharesVaultRegion(sourceRecord.path, targetRecord.path)) {
		boost += 0.035;
	}
	if (sourceRecord && hasTagOverlap(sourceRecord.tags, targetRecord.tags)) {
		boost += 0.035;
	}
	if (targetRecord.aliases.length > 0) {
		boost += 0.015;
	}
	return boost;
}

function genericTargetPenalty(
	query: string,
	sourceRecord: SemanticNoteRecord | null,
	targetRecord: SemanticNoteRecord,
	settings: SemanticAutoLinkerSettings,
): number {
	const normalizedQuery = normalizeText(query);
	const normalizedTitle = normalizeText(targetRecord.title);
	const titleTerms = tokenize(targetRecord.title);
	const queryTerms = tokenize(query);
	const genericTerms = new Set((settings.genericTargetTerms ?? FALLBACK_GENERIC_TARGET_TERMS).map(normalizeText));
	let penalty = 0;

	if (titleTerms.length === 1 && genericTerms.has(normalizedTitle)) {
		penalty += 0.2;
	}
	if (queryTerms.length === 1 && genericTerms.has(normalizedQuery)) {
		penalty += 0.16;
	}
	if (shouldSkipStructuralSemanticTarget(targetRecord, settings)) {
		penalty += 0.24;
	}
	if (sourceRecord && sharesVaultRegion(sourceRecord.path, targetRecord.path)) {
		penalty *= 0.45;
	}
	return penalty;
}

function getHybridNoLinkFloor(query: string, match: SemanticQueryMatch, settings: SemanticAutoLinkerSettings): number {
	const queryTerms = tokenize(query);
	const titleTerms = tokenize(match.targetTitle);
	const genericTerms = new Set((settings.genericTargetTerms ?? FALLBACK_GENERIC_TARGET_TERMS).map(normalizeText));
	if (queryTerms.length === 1 && genericTerms.has(queryTerms[0] ?? "")) {
		return 0.5;
	}
	if (titleTerms.length === 1 && genericTerms.has(titleTerms[0] ?? "")) {
		return 0.48;
	}
	if (matchesAnyStructuralPattern(match.targetTitle, match.targetPath, settings.excludedTargetPatterns ?? [])) {
		return 0.9;
	}
	if (settings.skipStructuralTargets !== false && matchesAnyStructuralPattern(match.targetTitle, match.targetPath, settings.structuralTargetPatterns ?? FALLBACK_STRUCTURAL_TARGET_PATTERNS)) {
		return 0.48;
	}
	return 0.28;
}

function shouldSkipStructuralSemanticTarget(record: SemanticNoteRecord, settings: SemanticAutoLinkerSettings): boolean {
	if (settings.skipStructuralTargets === false || record.aliases.length > 0) {
		return false;
	}
	return matchesAnyStructuralPattern(record.title, record.path, settings.structuralTargetPatterns ?? FALLBACK_STRUCTURAL_TARGET_PATTERNS);
}

function matchesAnyStructuralPattern(title: string, path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		const regex = wildcardPatternToRegex(pattern);
		return regex.test(title) || regex.test(path);
	});
}

function wildcardPatternToRegex(pattern: string): RegExp {
	const escaped = pattern.trim()
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function sharesVaultRegion(leftPath: string, rightPath: string): boolean {
	const leftFolder = firstFolder(leftPath);
	const rightFolder = firstFolder(rightPath);
	return Boolean(leftFolder && leftFolder === rightFolder);
}

function firstFolder(path: string): string {
	const [folder] = path.split("/");
	return path.includes("/") ? folder ?? "" : "";
}

function hasTagOverlap(leftTags: string[], rightTags: string[]): boolean {
	const left = new Set(leftTags.map(normalizeText).filter(Boolean));
	return rightTags.some((tag) => left.has(normalizeText(tag)));
}

function exactSingleTermSemanticBoost(
	queryTerms: Set<string>,
	titleTerms: Set<string>,
	aliasTerms: Set<string>,
	tagTerms: Set<string>,
): number {
	if (queryTerms.size !== 1) {
		return 0;
	}
	const [term] = [...queryTerms];
	if (!term) {
		return 0;
	}

	let boost = 0;
	if (titleTerms.has(term)) {
		boost += 0.18;
	}
	if (aliasTerms.has(term)) {
		boost += 0.16;
	}
	if (tagTerms.has(term)) {
		boost += 0.2;
	}
	return boost;
}

function sparseScore(queryTerms: string[], record: SemanticNoteRecord): number {
	const metadata = getRecordSearchMetadata(record);

	let score = 0;
	for (const term of queryTerms) {
		if (metadata.titleTerms.has(term)) {
			score += 0.9;
		}
		if (metadata.aliasTerms.has(term)) {
			score += 0.8;
		}
		if (metadata.tagTerms.has(term)) {
			score += 0.7;
		}
		const summaryHits = metadata.summaryCounts.get(term) ?? 0;
		if (summaryHits > 0) {
			score += Math.min(0.45, 0.18 + (summaryHits * 0.08));
		}
	}

	const normalizedQuery = normalizeText(queryTerms.join(" "));
	if (normalizedQuery && metadata.normalizedAliases.includes(normalizedQuery)) {
		score += 0.45;
	}
	if (normalizedQuery && metadata.normalizedTitle === normalizedQuery) {
		score += 0.5;
	}
	score += sparseAcronymBoost(normalizedQuery, record);
	score += sparseFuzzyPhraseBoost(queryTerms.join(" "), record);
	score += metadata.canonicalBoost * 3;
	score -= metadata.targetPenalty * 3;

	return Math.max(0, score);
}

function acronymSemanticBoost(normalizedQuery: string, record: SemanticNoteRecord): number {
	if (!normalizedQuery) {
		return 0;
	}
	const queryAcronym = buildPhraseAcronym(normalizedQuery);
	if (!queryAcronym || queryAcronym.length < 2) {
		return 0;
	}

	const metadata = getRecordSearchMetadata(record);

	let boost = 0;
	if (metadata.titleAcronym === queryAcronym) {
		boost += 0.24;
	}
	if (metadata.aliasAcronyms.includes(queryAcronym)) {
		boost += 0.22;
	}
	if (metadata.normalizedTitleCompact === queryAcronym) {
		boost += 0.28;
	}
	if (metadata.normalizedAliasesCompact.includes(queryAcronym)) {
		boost += 0.26;
	}
	return boost;
}

function sparseAcronymBoost(normalizedQuery: string, record: SemanticNoteRecord): number {
	if (!normalizedQuery) {
		return 0;
	}
	const queryAcronym = buildPhraseAcronym(normalizedQuery);
	if (!queryAcronym || queryAcronym.length < 2) {
		return 0;
	}
	const metadata = getRecordSearchMetadata(record);

	let boost = 0;
	if (metadata.normalizedTitleCompact === queryAcronym) {
		boost += 1.2;
	}
	if (metadata.normalizedAliasesCompact.includes(queryAcronym)) {
		boost += 1.1;
	}
	if (metadata.titleAcronym === queryAcronym) {
		boost += 0.95;
	}
	if (metadata.aliasAcronyms.includes(queryAcronym)) {
		boost += 0.9;
	}
	return boost;
}

function fuzzyPhraseBoost(query: string, record: SemanticNoteRecord): number {
	const compactQuery = compactNormalizeText(query);
	if (compactQuery.length < 4) {
		return 0;
	}

	let best = 0;
	for (const compactPhrase of getRecordSearchMetadata(record).compactPhrases) {
		if (compactPhrase === compactQuery) {
			best = Math.max(best, 0.22);
			continue;
		}
		const similarity = characterDice(compactQuery, compactPhrase);
		if (similarity >= 0.72) {
			best = Math.max(best, 0.06 + ((similarity - 0.72) * 0.5));
		}
	}
	return best;
}

function sparseFuzzyPhraseBoost(query: string, record: SemanticNoteRecord): number {
	const compactQuery = compactNormalizeText(query);
	if (compactQuery.length < 4) {
		return 0;
	}

	let best = 0;
	for (const compactPhrase of getRecordSearchMetadata(record).compactPhrases) {
		if (compactPhrase === compactQuery) {
			best = Math.max(best, 0.9);
			continue;
		}
		const similarity = characterDice(compactQuery, compactPhrase);
		if (similarity >= 0.72) {
			best = Math.max(best, 0.18 + ((similarity - 0.72) * 1.4));
		}
	}
	return best;
}

function targetPenalty(record: SemanticNoteRecord): number {
	const normalizedTitle = normalizeText(record.title);
	const normalizedPath = normalizeText(record.path);
	const normalizedTags = record.tags.map((tag) => normalizeText(tag)).join(" ");
	let penalty = 0;

	if (containsAny(normalizedTitle, ["benchmark", "guide", "map", "template", "archive", "fixture", "probe"])) {
		penalty += 0.18;
	}
	if (containsAny(normalizedPath, ["benchmark", "guide", "template", "archive", "probe"])) {
		penalty += 0.12;
	}
	if (containsAny(normalizedPath, ["daily", "current note"])) {
		penalty += 0.14;
	}
	if (containsAny(normalizedPath, ["idea", "hobby system"])) {
		penalty += 0.08;
	}
	if (containsAny(normalizedTags, ["benchmark", "fixture", "probe"])) {
		penalty += 0.12;
	}
	if (containsAny(normalizedTags, ["daily", "ideas", "hobby"])) {
		penalty += 0.08;
	}
	if (containsAny(normalizedTitle, ["challenge", "playground"])) {
		penalty += 0.06;
	}
	if (containsAny(normalizedPath, ["semantic playground"])) {
		penalty += 0.04;
	}
	if (containsAny(normalizedTags, ["semantic", "playground"])) {
		penalty += 0.04;
	}

	return penalty;
}

function canonicalTargetBoost(record: SemanticNoteRecord): number {
	const normalizedPath = normalizeText(record.path);
	const normalizedTags = record.tags.map((tag) => normalizeText(tag)).join(" ");
	let boost = 0;

	if (containsAny(normalizedPath, ["research"])) {
		boost += 0.03;
	}
	if (containsAny(normalizedTags, ["research", "ml", "pkm"])) {
		boost += 0.02;
	}
	if (record.aliases.length > 0) {
		boost += 0.02;
	}

	return boost;
}

function containsAny(value: string, terms: string[]): boolean {
	return terms.some((term) => value.includes(term));
}

function buildPhraseAcronym(value: string): string | null {
	const parts = tokenize(value).filter((part) => part.length > 0);
	if (parts.length < 2) {
		return null;
	}
	return parts.map((part) => part[0]?.toLowerCase() ?? "").join("");
}

function characterDice(left: string, right: string): number {
	const leftGrams = buildCharacterGrams(left);
	const rightGrams = buildCharacterGrams(right);
	if (leftGrams.size === 0 || rightGrams.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const gram of leftGrams) {
		if (rightGrams.has(gram)) {
			overlap += 1;
		}
	}
	return (2 * overlap) / (leftGrams.size + rightGrams.size);
}

function buildCharacterGrams(value: string): Set<string> {
	const padded = ` ${value} `;
	const grams = new Set<string>();
	for (let index = 0; index < padded.length - 2; index += 1) {
		grams.add(padded.slice(index, index + 3));
	}
	return grams;
}

function overlapRatio(queryTerms: Set<string>, candidateTerms: Set<string>): number {
	if (queryTerms.size === 0 || candidateTerms.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const term of queryTerms) {
		if (candidateTerms.has(term)) {
			overlap += 1;
		}
	}
	return overlap / queryTerms.size;
}

function buildQueryVectorCacheKey(providerId: string, modelId: string, query: string): string {
	return `${providerId}::${modelId}::${normalizeText(query)}`;
}

function buildQueryResultCacheKey(providerId: string, modelId: string, query: string, limit: number): string {
	return `${providerId}::${modelId}::${limit}::${normalizeText(query)}`;
}

function buildSparseResultCacheKey(query: string, limit: number): string {
	return `${limit}::${normalizeText(query)}`;
}

function getExpandedHybridLimit(limit: number): number {
	return Math.max(limit * 4, 24);
}

async function notifyProgress(
	onProgress: ((progress: SemanticBuildProgress) => void | Promise<void>) | undefined,
	progress: SemanticBuildProgress,
): Promise<void> {
	if (!onProgress) {
		return;
	}
	await onProgress(progress);
}

function summarizeNote(source: string, maxLength: number): string {
	const cleaned = source
		.replace(FRONTMATTER_REGEX, "")
		.replace(FENCED_BLOCK_REGEX, " ")
		.replace(INLINE_CODE_REGEX, " ")
		.replace(WIKILINK_REGEX, (_full, target: string, alias: string | undefined) => alias ?? target)
		.replace(MARKDOWN_LINK_REGEX, "$1")
		.replace(HEADING_REGEX, "")
		.replace(/\s+/g, " ")
		.trim();

	return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 3).trim()}...`;
}

function buildSemanticSourceText(note: NoteRecord, summary: string): string {
	const aliases = note.aliases.join(", ");
	const tags = note.tags.join(" ");
	return [note.title, aliases, summary, tags].filter(Boolean).join("\n");
}

function isCacheFresh(
	entry: SemanticCacheEntry,
	mtime: number,
	providerId: string,
	modelId: string,
	sourceText: string,
): boolean {
	return entry.mtime === mtime
		&& entry.providerId === providerId
		&& entry.modelId === modelId
		&& entry.sourceText === sourceText
		&& entry.embedding.length > 0;
}

function isCacheMetadataFresh(
	entry: SemanticCacheEntry,
	mtime: number,
	providerId: string,
	modelId: string,
): boolean {
	return entry.mtime === mtime
		&& entry.providerId === providerId
		&& entry.modelId === modelId
		&& entry.sourceText.length > 0
		&& entry.embedding.length > 0;
}

function isStoredCacheUsable(entry: SemanticCacheEntry, mtime: number): boolean {
	return entry.mtime === mtime
		&& typeof entry.providerId === "string"
		&& entry.providerId.length > 0
		&& typeof entry.modelId === "string"
		&& entry.modelId.length > 0
		&& typeof entry.sourceText === "string"
		&& entry.sourceText.length > 0
		&& typeof entry.summary === "string"
		&& Array.isArray(entry.embedding)
		&& entry.embedding.length > 0;
}

function getEmbeddingBatchSize(providerId: string, settings: SemanticAutoLinkerSettings, pendingCount: number): number {
	if (pendingCount <= DEFAULT_EMBEDDING_BATCH_SIZE) {
		return DEFAULT_EMBEDDING_BATCH_SIZE;
	}
	if (providerId === "ollama") {
		return 64;
	}
	if (providerId === "local-fallback") {
		return 128;
	}
	if (providerId === "transformers" && settings.semanticTransformersDevice !== "cpu") {
		return 16;
	}
	return DEFAULT_EMBEDDING_BATCH_SIZE;
}

function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length === 0 || right.length === 0 || left.length !== right.length) {
		return Number.NEGATIVE_INFINITY;
	}
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;
		dot += leftValue * rightValue;
		leftNorm += leftValue * leftValue;
		rightNorm += rightValue * rightValue;
	}
	if (leftNorm === 0 || rightNorm === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeProjection(
	output: number[][],
	entries: Array<{ id: string; path: string; title: string; parentTitle: string; kind: "note" | "concept"; tags: string[]; region: string }>,
): SemanticProjectionPoint[] {
	const xs = output.map((point) => point[0] ?? 0);
	const ys = output.map((point) => point[1] ?? 0);
	const zs = output.map((point) => point[2] ?? 0);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const minZ = Math.min(...zs);
	const maxZ = Math.max(...zs);

	return output.map((point, index) => ({
		id: entries[index]?.id ?? "",
		path: entries[index]?.path ?? "",
		title: entries[index]?.title ?? "",
		parentTitle: entries[index]?.parentTitle ?? entries[index]?.title ?? "",
		kind: entries[index]?.kind ?? "note",
		tags: entries[index]?.tags ?? [],
		x: scaleToUnit(point[0] ?? 0, minX, maxX),
		y: scaleToUnit(point[1] ?? 0, minY, maxY),
		z: scaleToUnit(point[2] ?? 0, minZ, maxZ),
		region: entries[index]?.region ?? "Root",
	})).filter((point) => point.id && point.path);
}

function scaleToUnit(value: number, min: number, max: number): number {
	if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || min === max) {
		return 0;
	}
	return ((value - min) / (max - min)) * 2 - 1;
}

function deriveRegion(path: string): string {
	const [region] = path.split("/");
	return region?.trim() || "Root";
}

function prepareProjectionVector(vector: number[], metric: SemanticAutoLinkerSettings["semanticProjectionMetric"]): number[] {
	if (metric !== "cosine") {
		return vector;
	}
	let norm = 0;
	for (const value of vector) {
		norm += value * value;
	}
	if (norm === 0) {
		return vector;
	}
	const scale = Math.sqrt(norm);
	return vector.map((value) => value / scale);
}

function uniqueConceptLabels(record: SemanticNoteRecord): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const label of extractConceptLabels(record)) {
		const trimmed = label.trim();
		if (!trimmed) {
			continue;
		}
		const key = normalizeText(trimmed);
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		labels.push(trimmed);
	}
	return labels;
}

function extractConceptLabels(record: SemanticNoteRecord): string[] {
	const titleKey = normalizeText(record.title);
	const aliasKeys = new Set(record.aliases.map((alias) => normalizeText(alias)).filter(Boolean));
	const summaryLabels = extractSummaryConceptPhrases(record.summary)
		.filter((label) => {
			const key = normalizeText(label);
			return Boolean(key) && key !== titleKey && !aliasKeys.has(key);
		});

	const labels = [
		...summaryLabels,
		...record.aliases,
		record.title,
	];

	return labels.slice(0, 4);
}

function extractSummaryConceptPhrases(summary: string): string[] {
	const cleaned = summary
		.replace(/[()[\]{}"“”'’]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) {
		return [];
	}

	const words = cleaned
		.split(/\s+/)
		.map((word) => word.replace(/^[^A-Za-z0-9#+-]+|[^A-Za-z0-9#+-]+$/g, ""))
		.filter(Boolean);
	const candidates = new Map<string, number>();

	for (let start = 0; start < words.length; start += 1) {
		for (let length = 2; length <= 4; length += 1) {
			const parts = words.slice(start, start + length);
			if (parts.length < 2) {
				continue;
			}
			const normalized = normalizeText(parts.join(" "));
			if (!isConceptPhrase(normalized)) {
				continue;
			}
			const score = scoreConceptPhrase(normalized);
			const current = candidates.get(normalized) ?? Number.NEGATIVE_INFINITY;
			if (score > current) {
				candidates.set(normalized, score);
			}
		}
	}

	return [...candidates.entries()]
		.sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
		.slice(0, 3)
		.map(([label]) => label.split(" ").map(capitalizeWord).join(" "));
}

function isConceptPhrase(phrase: string): boolean {
	if (!phrase) {
		return false;
	}
	const parts = phrase.split(" ").filter(Boolean);
	if (parts.length < 2) {
		return false;
	}
	const stopWords = new Set([
		"a", "an", "the", "and", "or", "but", "for", "with", "that", "this", "these", "those", "into", "from", "over", "under",
		"about", "they", "them", "their", "then", "than", "have", "has", "had", "been", "being", "will", "would", "could", "should",
		"just", "also", "very", "more", "most", "some", "such", "like", "near", "note", "notes", "workflow", "workflows",
		"used", "using", "instead", "rather", "without", "even", "though", "still", "feel", "close",
	]);
	if (stopWords.has(parts[0] ?? "") || stopWords.has(parts[parts.length - 1] ?? "")) {
		return false;
	}
	const contentWords = parts.filter((part) => part.length > 2 && !stopWords.has(part));
	return contentWords.length >= 2;
}

function scoreConceptPhrase(phrase: string): number {
	const parts = phrase.split(" ").filter(Boolean);
	const contentWords = parts.filter((part) => part.length > 2);
	const longWords = contentWords.filter((part) => part.length >= 7).length;
	const hyphenBonus = phrase.includes("-") ? 0.4 : 0;
	return (contentWords.length * 2) + longWords + hyphenBonus + Math.min(phrase.length / 18, 1.5);
}

function capitalizeWord(word: string): string {
	if (!word) {
		return word;
	}
	return word.charAt(0).toUpperCase() + word.slice(1);
}
