import { TFile, Vault } from "obsidian";
import type {
	AnalysisResult,
	PersistedVaultAnalysisResult,
	PersistedVaultAnalysisSnapshot,
	VaultAnalysisJobState,
	VaultAnalysisResult,
	VaultGraphMetrics,
	VaultGraphPreview,
} from "./types";

const EMPTY_GRAPH_METRICS: VaultGraphMetrics = {
	noteCount: 0,
	notesWithLinksBefore: 0,
	notesWithLinksAfter: 0,
	existingLinkCount: 0,
	projectedLinkCount: 0,
	projectedAddedLinks: 0,
};

const EMPTY_GRAPH_PREVIEW: VaultGraphPreview = {
	nodes: [],
	edgesBefore: [],
	edgesAfter: [],
};

export function createInitialVaultAnalysisJobState(): VaultAnalysisJobState {
	return {
		status: "idle",
		mode: "full",
		current: 0,
		total: 0,
		message: "No whole-vault analysis has run yet.",
		startedAt: null,
		updatedAt: null,
		completedAt: null,
		error: null,
		stalePaths: [],
	};
}

export function serializeVaultAnalysis(
	analysis: VaultAnalysisResult,
	revision: number,
): PersistedVaultAnalysisSnapshot {
	return {
		results: analysis.results.map(serializeAnalysisResult),
		sourcesByPath: { ...analysis.sourcesByPath },
		updatedAt: Date.now(),
		revision,
	};
}

export function hydrateVaultAnalysis(
	vault: Vault,
	snapshot: PersistedVaultAnalysisSnapshot | null | undefined,
): VaultAnalysisResult | null {
	if (!snapshot) {
		return null;
	}

	const results: AnalysisResult[] = [];
	const sourcesByPath: Record<string, string> = {};

	for (const result of snapshot.results) {
		const file = vault.getAbstractFileByPath(result.filePath);
		if (!(file instanceof TFile)) {
			continue;
		}

		results.push({
			file,
			scopeLabel: result.scopeLabel,
			suggestions: result.suggestions.map((suggestion) => ({ ...suggestion })),
			source: result.source,
			selection: result.selection ? { ...result.selection } : undefined,
		});
		sourcesByPath[result.filePath] = result.source;
	}

	for (const [path, source] of Object.entries(snapshot.sourcesByPath)) {
		if (!(vault.getAbstractFileByPath(path) instanceof TFile)) {
			continue;
		}
		if (!(path in sourcesByPath)) {
			sourcesByPath[path] = source;
		}
	}

	return {
		results,
		totalSuggestions: 0,
		filesWithSuggestions: 0,
		graphMetrics: { ...EMPTY_GRAPH_METRICS },
		sourcesByPath,
		graphPreview: {
			nodes: [...EMPTY_GRAPH_PREVIEW.nodes],
			edgesBefore: [...EMPTY_GRAPH_PREVIEW.edgesBefore],
			edgesAfter: [...EMPTY_GRAPH_PREVIEW.edgesAfter],
		},
	};
}

function serializeAnalysisResult(result: AnalysisResult): PersistedVaultAnalysisResult {
	return {
		filePath: result.file.path,
		scopeLabel: result.scopeLabel,
		suggestions: result.suggestions.map((suggestion) => ({ ...suggestion })),
		source: result.source,
		selection: result.selection ? { ...result.selection } : undefined,
	};
}
