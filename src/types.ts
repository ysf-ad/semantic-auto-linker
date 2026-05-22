import type { TFile } from "obsidian";

export interface SemanticAutoLinkerSettings {
	firstOccurrenceOnly: boolean;
	maxLinksPerNote: number;
	excludedFolders: string[];
	excludedFiles: string[];
	excludedTargetFiles: string[];
	enableAliasMatching: boolean;
	skipHeadings: boolean;
	seeAlsoHeading: string;
	seeAlsoCount: number;
	semanticMode: boolean;
	semanticProviderId: string;
	semanticTopK: number;
	semanticSummaryLength: number;
	semanticOllamaBaseUrl: string;
	semanticOllamaModel: string;
	semanticProjectionMetric: "cosine" | "euclidean";
	semanticExplorerLabelDistance: number;
	semanticDisplayThreshold: number;
	semanticAcceptanceThreshold: number;
	autoRefreshEnabled: boolean;
	autoRefreshMinutes: number;
}

export interface NoteRecord {
	file: TFile;
	path: string;
	linkTarget: string;
	title: string;
	aliases: string[];
	normalizedTitle: string;
	titleTokens: string[];
	lookupKeys: string[];
	tags: string[];
}

export interface Range {
	start: number;
	end: number;
}

export interface LinkSuggestion {
	id: string;
	sourcePath: string;
	targetPath: string;
	targetTitle: string;
	targetLink: string;
	matchedText: string;
	replacement: string;
	start: number;
	end: number;
	reason: string;
	confidence: number;
	context: string;
	accepted: boolean;
	matchType?: "title" | "alias" | "acronym" | "semantic";
}

export interface AnalysisResult {
	file: TFile;
	scopeLabel: string;
	suggestions: LinkSuggestion[];
	source: string;
	selection?: Range;
}

export interface VaultGraphMetrics {
	noteCount: number;
	notesWithLinksBefore: number;
	notesWithLinksAfter: number;
	existingLinkCount: number;
	projectedLinkCount: number;
	projectedAddedLinks: number;
}

export interface GraphNode {
	id: string;
	label: string;
	degreeBefore: number;
	degreeAfter: number;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	projected: boolean;
}

export interface VaultGraphPreview {
	nodes: GraphNode[];
	edgesBefore: GraphEdge[];
	edgesAfter: GraphEdge[];
}

export interface VaultAnalysisResult {
	results: AnalysisResult[];
	totalSuggestions: number;
	filesWithSuggestions: number;
	graphMetrics: VaultGraphMetrics;
	sourcesByPath: Record<string, string>;
	graphPreview: VaultGraphPreview;
}

export interface PersistedVaultAnalysisResult {
	filePath: string;
	scopeLabel: string;
	suggestions: LinkSuggestion[];
	source: string;
	selection?: Range;
}

export interface PersistedVaultAnalysisSnapshot {
	results: PersistedVaultAnalysisResult[];
	sourcesByPath: Record<string, string>;
	updatedAt: number;
	revision: number;
}

export interface VaultAnalysisJobState {
	status: "idle" | "running" | "updating" | "complete" | "failed";
	mode: "full" | "incremental";
	current: number;
	total: number;
	message: string;
	startedAt: number | null;
	updatedAt: number | null;
	completedAt: number | null;
	error: string | null;
	stalePaths: string[];
}

export interface VaultAnalysisRunProgress {
	stage: "reading" | "analyzing" | "complete";
	current: number;
	total: number;
	message: string;
	preview?: VaultAnalysisResult;
}

export interface RelatedNoteSuggestion {
	targetPath: string;
	targetTitle: string;
	targetLink: string;
	reason: string;
	score: number;
	previewText?: string;
	accepted?: boolean;
	matchType?: "deterministic" | "semantic";
}

export interface SemanticCacheEntry {
	path: string;
	providerId: string;
	modelId: string;
	mtime: number;
	sourceText: string;
	summary: string;
	embedding: number[];
	updatedAt: number;
}

export interface SemanticNoteRecord {
	path: string;
	title: string;
	aliases: string[];
	tags: string[];
	summary: string;
	sourceText: string;
	mtime: number;
	providerId: string | null;
	modelId: string | null;
	embedding: number[] | null;
}

export interface SemanticProjectionPoint {
	id: string;
	path: string;
	title: string;
	parentTitle: string;
	kind: "note" | "concept";
	tags: string[];
	x: number;
	y: number;
	z: number;
	region: string;
}

export interface SemanticQueryMatch {
	query: string;
	targetPath: string;
	targetTitle: string;
	targetLink: string;
	score: number;
}

export interface SemanticIndexStatus {
	providerId: string;
	providerLabel: string;
	available: boolean;
	reason: string | null;
	noteCount: number;
	cachedCount: number;
	pendingCount: number;
	vectorDimensions: number | null;
	lastBuiltAt: number | null;
}

export interface SemanticProviderModel {
	id: string;
	label: string;
}

export interface SemanticBuildProgress {
	stage: "checking-provider" | "preparing-notes" | "embedding" | "complete";
	current: number;
	total: number;
	message: string;
}

export interface PluginStorageData {
	settings: Partial<SemanticAutoLinkerSettings>;
	semanticCache: Record<string, SemanticCacheEntry>;
	vaultAnalysisSnapshot?: PersistedVaultAnalysisSnapshot | null;
	vaultAnalysisJobState?: VaultAnalysisJobState | null;
}
