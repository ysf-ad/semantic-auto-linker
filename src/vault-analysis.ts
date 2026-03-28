import type {
	AnalysisResult,
	GraphEdge,
	GraphNode,
	NoteRecord,
	VaultAnalysisRunProgress,
	VaultAnalysisResult,
	VaultGraphMetrics,
	VaultGraphPreview,
} from "./types";
import type { SemanticAutoLinkerSettings } from "./types";
import { analyzeNoteContent } from "./matcher";
import type { SemanticIndex } from "./semantic-index";
import { VaultIndex } from "./vault-index";

const WIKILINK_REGEX = /\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?]]/g;

export async function analyzeEntireVault(
	index: VaultIndex,
	settings: SemanticAutoLinkerSettings,
	semanticIndex: SemanticIndex,
	readFile: (record: NoteRecord) => Promise<string>,
	onProgress?: (progress: VaultAnalysisRunProgress) => void | Promise<void>,
): Promise<VaultAnalysisResult> {
	const records = index.getAll();
	await emitProgress(onProgress, {
		stage: "reading",
		current: 0,
		total: records.length,
		message: `Reading ${records.length} note${records.length === 1 ? "" : "s"}...`,
	});
	let readCount = 0;
	const sources = await mapWithConcurrency(records, 8, async (record) => ({
		record,
		source: await readFile(record),
	}), async () => {
		readCount += 1;
		await emitProgress(onProgress, {
			stage: "reading",
			current: readCount,
			total: records.length,
			message: `Read ${readCount}/${records.length} note${records.length === 1 ? "" : "s"}.`,
		});
	});
	const sourcesByPath: Record<string, string> = {};
	for (const entry of sources) {
		sourcesByPath[entry.record.path] = entry.source;
	}

	await emitProgress(onProgress, {
		stage: "analyzing",
		current: 0,
		total: sources.length,
		message: `Analyzing ${sources.length} note${sources.length === 1 ? "" : "s"}...`,
	});
	let analyzedCount = 0;
	const analyzed = await mapWithConcurrency(sources, 8, async ({ record, source }) =>
		await analyzeNoteContent(record, source, index, settings, semanticIndex),
		async () => {
			analyzedCount += 1;
			await emitProgress(onProgress, {
				stage: "analyzing",
				current: analyzedCount,
				total: sources.length,
				message: `Analyzed ${analyzedCount}/${sources.length} note${sources.length === 1 ? "" : "s"}.`,
			});
		},
	);
	const results = analyzed.filter((analysis) => analysis.suggestions.length > 0);

	const analysisResult: VaultAnalysisResult = {
		results,
		totalSuggestions: 0,
		filesWithSuggestions: 0,
		graphMetrics: emptyMetrics(records.length),
		sourcesByPath,
		graphPreview: { nodes: [], edgesBefore: [], edgesAfter: [] },
	};

	recomputeVaultAnalysis(analysisResult, records);
	await emitProgress(onProgress, {
		stage: "complete",
		current: records.length,
		total: records.length,
		message: `Prepared ${analysisResult.totalSuggestions} accepted suggestion${analysisResult.totalSuggestions === 1 ? "" : "s"} across the vault.`,
	});
	return analysisResult;
}

async function mapWithConcurrency<TInput, TOutput>(
	items: TInput[],
	concurrency: number,
	mapper: (item: TInput, index: number) => Promise<TOutput>,
	onResolved?: (item: TOutput, index: number) => void | Promise<void>,
): Promise<TOutput[]> {
	if (items.length === 0) {
		return [];
	}

	const results = new Array<TOutput>(items.length);
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));

	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) {
				return;
			}
			const item = items[currentIndex];
			if (item === undefined) {
				continue;
			}
			const resolved = await mapper(item, currentIndex);
			results[currentIndex] = resolved;
			await onResolved?.(resolved, currentIndex);
		}
	});

	await Promise.all(workers);
	return results;
}

async function emitProgress(
	onProgress: ((progress: VaultAnalysisRunProgress) => void | Promise<void>) | undefined,
	progress: VaultAnalysisRunProgress,
): Promise<void> {
	if (!onProgress) {
		return;
	}
	await onProgress(progress);
}

export function recomputeVaultAnalysis(analysis: VaultAnalysisResult, records: NoteRecord[]): void {
	analysis.totalSuggestions = analysis.results.reduce(
		(total, result) => total + result.suggestions.filter((suggestion) => suggestion.accepted).length,
		0,
	);
	analysis.filesWithSuggestions = analysis.results.filter((result) =>
		result.suggestions.some((suggestion) => suggestion.accepted),
	).length;
	analysis.graphPreview = buildGraphPreview(records, analysis.results, analysis.sourcesByPath);
	analysis.graphMetrics = computeGraphMetrics(records.length, analysis.graphPreview);
}

function buildGraphPreview(records: NoteRecord[], results: AnalysisResult[], sourcesByPath: Record<string, string>): VaultGraphPreview {
	const linkTargetToPath = new Map<string, string>();
	for (const record of records) {
		linkTargetToPath.set(record.linkTarget, record.path);
		linkTargetToPath.set(record.title, record.path);
	}

	const beforeEdges = new Map<string, GraphEdge>();
	const afterEdges = new Map<string, GraphEdge>();
	const degreeBefore = new Map<string, number>();
	const degreeAfter = new Map<string, number>();

	for (const record of records) {
		const source = sourcesByPath[record.path] ?? "";
		for (const targetPath of extractTargetPaths(source, linkTargetToPath)) {
			const edge = createEdge(record.path, targetPath, false);
			beforeEdges.set(edge.id, edge);
			afterEdges.set(edge.id, edge);
		}
	}

	for (const result of results) {
		for (const suggestion of result.suggestions) {
			if (!suggestion.accepted) {
				continue;
			}
			const edge = createEdge(result.file.path, suggestion.targetPath, true);
			if (!afterEdges.has(edge.id)) {
				afterEdges.set(edge.id, edge);
			}
		}
	}

	for (const edge of beforeEdges.values()) {
		incrementDegree(degreeBefore, edge.source);
		incrementDegree(degreeBefore, edge.target);
	}

	for (const edge of afterEdges.values()) {
		incrementDegree(degreeAfter, edge.source);
		incrementDegree(degreeAfter, edge.target);
	}

	const nodes: GraphNode[] = records
		.map((record) => ({
			id: record.path,
			label: record.title,
			degreeBefore: degreeBefore.get(record.path) ?? 0,
			degreeAfter: degreeAfter.get(record.path) ?? 0,
		}))
		.sort((left, right) => right.degreeAfter - left.degreeAfter || left.label.localeCompare(right.label));

	return {
		nodes,
		edgesBefore: [...beforeEdges.values()],
		edgesAfter: [...afterEdges.values()],
	};
}

function computeGraphMetrics(noteCount: number, preview: VaultGraphPreview): VaultGraphMetrics {
	return {
		noteCount,
		notesWithLinksBefore: preview.nodes.filter((node) => node.degreeBefore > 0).length,
		notesWithLinksAfter: preview.nodes.filter((node) => node.degreeAfter > 0).length,
		existingLinkCount: preview.edgesBefore.length,
		projectedLinkCount: preview.edgesAfter.length,
		projectedAddedLinks: preview.edgesAfter.length - preview.edgesBefore.length,
	};
}

function extractTargetPaths(source: string, linkTargetToPath: Map<string, string>): string[] {
	return Array.from(source.matchAll(WIKILINK_REGEX), (match) => {
		const raw = match[1]?.trim() ?? "";
		return linkTargetToPath.get(raw) ?? "";
	}).filter(Boolean);
}

function createEdge(source: string, target: string, projected: boolean): GraphEdge {
	return {
		id: `${source}=>${target}`,
		source,
		target,
		projected,
	};
}

function incrementDegree(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function emptyMetrics(noteCount: number): VaultGraphMetrics {
	return {
		noteCount,
		notesWithLinksBefore: 0,
		notesWithLinksAfter: 0,
		existingLinkCount: 0,
		projectedLinkCount: 0,
		projectedAddedLinks: 0,
	};
}
