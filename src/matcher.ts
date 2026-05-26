import type { AnalysisResult, LinkSuggestion, NoteRecord, Range, SemanticAutoLinkerSettings, SemanticQueryMatch } from "./types";
import { buildContextSnippet, compactNormalizeText, indexTokens, normalizeText, tokenize } from "./text-utils";
import { getProtectedRanges, overlapsRange } from "./protected-ranges";
import { VaultIndex } from "./vault-index";
import type { SemanticIndex } from "./semantic-index";

const MAX_EXACT_PHRASE_TOKENS = 8;
const MAX_ACRONYM_PHRASE_TOKENS = 6;
const MAX_ANALYSIS_SOURCE_CHARS = 24_000;
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
interface PhraseCandidate {
	note: NoteRecord;
	reason: string;
	phrase: string;
}

export interface AnalysisMatchingContext {
	candidates: Map<number, Map<string, PhraseCandidate[]>>;
	acronymCandidates: Map<string, PhraseCandidate[]>;
	candidateLengthsByFirstToken: Map<string, number[]>;
	acronymFallbackLengths: number[];
	acronymStartLetters: Set<string>;
	maxTokenLength: number;
	semanticSingleWordHints: Set<string>;
	skipSemanticDocumentGate?: boolean;
	useNoteSemanticCandidates?: boolean;
}

export function buildAnalysisMatchingContext(
	index: VaultIndex,
	settings: SemanticAutoLinkerSettings,
	excludedTargetPaths = new Set(settings.excludedTargetFiles ?? []),
): AnalysisMatchingContext {
	const candidates = settings.enableExactMatching !== false
		? buildCandidateMap(index, "", settings, excludedTargetPaths)
		: new Map<number, Map<string, PhraseCandidate[]>>();
	const acronymCandidates = settings.enableExactMatching !== false
		? buildAcronymCandidateMap(index, "", settings, excludedTargetPaths)
		: new Map<string, PhraseCandidate[]>();
	const maxTokenLength = Math.min(Math.max(...candidates.keys(), 1), MAX_EXACT_PHRASE_TOKENS);

	return {
		candidates,
		acronymCandidates,
		candidateLengthsByFirstToken: settings.enableExactMatching !== false
			? buildCandidateLengthsByFirstToken(candidates, maxTokenLength)
			: new Map<string, number[]>(),
		acronymFallbackLengths: acronymCandidates.size > 0
			? buildDescendingRange(Math.min(maxTokenLength, MAX_ACRONYM_PHRASE_TOKENS), 2)
			: [],
		acronymStartLetters: buildAcronymStartLetters(acronymCandidates),
		maxTokenLength,
		semanticSingleWordHints: buildSemanticSingleWordHints(index, "", settings, excludedTargetPaths),
	};
}

export async function analyzeNoteContent(
	file: NoteRecord,
	source: string,
	index: VaultIndex,
	settings: SemanticAutoLinkerSettings,
	semanticIndex?: SemanticIndex,
	selection?: Range,
	matchingContext?: AnalysisMatchingContext,
): Promise<AnalysisResult> {
	const analysisSource = selection ? source : truncateAnalysisSource(source);
	const protectedRanges = getProtectedRanges(analysisSource, settings.skipHeadings);
	const existingTargets = new Set(extractExistingTargets(source));
	const usedTargets = new Set(existingTargets);
	const excludedTargetPaths = new Set(settings.excludedTargetFiles ?? []);
	const exactMatchingEnabled = settings.enableExactMatching !== false;
	const semanticSuggestionsEnabled = settings.enableSemanticSuggestions !== false;
	const candidates = exactMatchingEnabled ? matchingContext?.candidates ?? buildCandidateMap(index, file.path, settings, excludedTargetPaths) : new Map<number, Map<string, PhraseCandidate[]>>();
	const acronymCandidates = exactMatchingEnabled ? matchingContext?.acronymCandidates ?? buildAcronymCandidateMap(index, file.path, settings, excludedTargetPaths) : new Map<string, PhraseCandidate[]>();
	const tokens = indexTokens(analysisSource);
	const suggestions: LinkSuggestion[] = [];
	const occupied = new Array<boolean>(tokens.length).fill(false);
	const displaySuggestionLimit = settings.maxLinksPerNote > 0
		? Math.max(settings.maxLinksPerNote * 3, settings.maxLinksPerNote + 8)
		: Number.POSITIVE_INFINITY;
	const semanticSingleWordHints = matchingContext?.semanticSingleWordHints ?? buildSemanticSingleWordHints(index, file.path, settings, excludedTargetPaths);

	const maxTokenLength = matchingContext?.maxTokenLength ?? Math.min(Math.max(...candidates.keys(), 1), MAX_EXACT_PHRASE_TOKENS);
	const candidateLengthsByFirstToken = exactMatchingEnabled
		? matchingContext?.candidateLengthsByFirstToken ?? buildCandidateLengthsByFirstToken(candidates, maxTokenLength)
		: new Map<string, number[]>();
	const acronymFallbackLengths = matchingContext?.acronymFallbackLengths
		?? (acronymCandidates.size > 0 ? buildDescendingRange(Math.min(maxTokenLength, MAX_ACRONYM_PHRASE_TOKENS), 2) : []);
	const acronymStartLetters = matchingContext?.acronymStartLetters ?? buildAcronymStartLetters(acronymCandidates);
	const selectionStart = selection?.start ?? 0;
	const selectionEnd = selection?.end ?? analysisSource.length;

	exactScan:
	for (let startIndex = 0; exactMatchingEnabled && startIndex < tokens.length; startIndex += 1) {
		if (suggestions.length >= displaySuggestionLimit) {
			break;
		}
		if (occupied[startIndex]) {
			continue;
		}

		const startToken = tokens[startIndex];
		if (!startToken) {
			continue;
		}
		if (startToken.start < selectionStart || startToken.end > selectionEnd) {
			continue;
		}

		const candidateLengths = candidateLengthsByFirstToken.get(startToken.normalized)
			?? (acronymStartLetters.has(startToken.normalized[0] ?? "") ? acronymFallbackLengths : []);
		if (candidateLengths.length === 0) {
			continue;
		}

		for (const tokenLength of candidateLengths) {
			const endIndex = startIndex + tokenLength - 1;
			const endToken = tokens[endIndex];
			if (!endToken) {
				continue;
			}
			if (endToken.end > selectionEnd) {
				continue;
			}
			if (isAnyOccupied(occupied, startIndex, endIndex)) {
				continue;
			}
			if (overlapsRange(startToken.start, endToken.end, protectedRanges)) {
				continue;
			}

			const rawPhrase = analysisSource.slice(startToken.start, endToken.end);
			const key = normalizeText(rawPhrase);
			if (isIgnoredMatchTerm(key, settings)) {
				continue;
			}
			const compactKey = compactNormalizeText(rawPhrase);
			const matches = candidates.get(tokenLength)?.get(key) ?? candidates.get(tokenLength)?.get(compactKey) ?? [];
			const acronymMatches = matches.length === 0
				? getAcronymCandidatesForSpan(acronymCandidates, tokens, startIndex, endIndex)
				: [];
			const combinedMatches = matches.length > 0 ? matches : acronymMatches;
			const match = combinedMatches.find((candidate) =>
				candidate.note.path !== file.path
				&& !usedTargets.has(candidate.note.path)
				&& !usedTargets.has(candidate.note.linkTarget)
				&& !isLowSignalExactCandidate(candidate, rawPhrase, file, settings),
			);
			if (!match) {
				continue;
			}

			const matchedText = analysisSource.slice(startToken.start, endToken.end);
			const replacement = buildReplacement(match.note.linkTarget, match.note.title, matchedText);
			suggestions.push({
				id: `${match.note.path}:${startToken.start}:${endToken.end}`,
				sourcePath: file.path,
				targetPath: match.note.path,
				targetTitle: match.note.title,
				targetLink: match.note.linkTarget,
				matchedText,
				replacement,
				start: startToken.start,
				end: endToken.end,
				reason: match.reason,
				confidence: match.reason === "title" ? 0.99 : match.reason === "acronym" ? 0.95 : 0.9,
				context: buildContextSnippet(source, startToken.start, endToken.end),
				accepted: true,
				matchType: match.reason === "title" ? "title" : match.reason === "acronym" ? "acronym" : "alias",
			});
			markOccupied(occupied, startIndex, endIndex);
			usedTargets.add(match.note.path);
			usedTargets.add(match.note.linkTarget);
			if (suggestions.length >= displaySuggestionLimit) {
				break exactScan;
			}
			break;
		}

	}

	if (semanticIndex && settings.semanticMode && semanticSuggestionsEnabled && suggestions.length < displaySuggestionLimit) {
		try {
			const semanticSpans = buildSemanticSpanCandidates(tokens, analysisSource, occupied, protectedRanges, selectionStart, selectionEnd, semanticSingleWordHints, settings);
			if (semanticSpans.length > 0) {
				const documentMatches = matchingContext?.useNoteSemanticCandidates
					? await semanticIndex.findRelatedNotesForPath(file.path, usedTargets, Math.max(settings.semanticTopK * 2, 12))
					: matchingContext?.skipSemanticDocumentGate
						? []
						: await findDocumentSemanticMatches(semanticIndex, semanticSpans, analysisSource, settings, file.path);
				const candidateLimit = matchingContext?.useNoteSemanticCandidates
					? Math.max(settings.semanticTopK * 2, 12)
					: Math.max(settings.semanticTopK, 6);
				const candidateTargetPaths = new Set(
					documentMatches
						.filter((match) => !excludedTargetPaths.has(match.targetPath))
						.filter((match) => matchingContext?.useNoteSemanticCandidates || match.score >= Math.max(settings.semanticDisplayThreshold, 0.42))
						.slice(0, candidateLimit)
						.map((match) => match.targetPath),
				);
				const spanBudget = matchingContext?.useNoteSemanticCandidates || candidateTargetPaths.size === 0 ? 6 : 4;
				const spanQueries = semanticSpans
					.slice(0, spanBudget)
					.map((span) => span.normalized);
				const matchesByQuery = new Map<string, SemanticQueryMatch[]>();
				await Promise.all(
					spanQueries.map(async (query) => {
						const mergedMatches = await semanticIndex.findHybridSimilarNotes(
							query,
							file.path,
							settings.semanticTopK,
							candidateTargetPaths.size > 0 ? candidateTargetPaths : undefined,
						);
						const shortlistedMatches = candidateTargetPaths.size > 0
							? mergedMatches.filter((match) => candidateTargetPaths.has(match.targetPath))
							: mergedMatches;
						matchesByQuery.set(query, shortlistedMatches.length > 0 ? shortlistedMatches : mergedMatches);
					}),
				);
				const semanticCandidates: LinkSuggestion[] = [];
				for (const span of semanticSpans.slice(0, spanBudget)) {
					const matches = matchesByQuery.get(span.normalized) ?? [];
					const rankedMatches = matches
						.map((match) => ({
							...match,
							score: match.score + (candidateTargetPaths.has(match.targetPath) ? 0.08 : 0),
						}))
						.filter((match) =>
							!excludedTargetPaths.has(match.targetPath)
							&& match.score >= settings.semanticDisplayThreshold
							&& normalizeText(span.text) !== normalizeText(match.targetTitle),
						);
					const best = rankedMatches[0];
					if (!best) {
						continue;
					}
					const chosen = rankedMatches.find((match, index) => {
						if (!match) {
							return false;
						}
						if (!usedTargets.has(match.targetPath) && !usedTargets.has(match.targetLink)) {
							if (index === 0) {
								return true;
							}
							return match.score >= 0.5 && best.score - match.score <= 0.03;
						}
						return false;
					});
					if (!chosen) {
						continue;
					}
					const secondBest = rankedMatches.find((match) =>
						match.targetPath !== chosen.targetPath
						&& match.targetLink !== chosen.targetLink,
					);
					const isStrongSingleWordSpan = span.normalized.split(" ").length === 1 && isStrongSingleWordSemanticSpan(span.normalized, semanticSingleWordHints);
					const isAmbiguous = Boolean(
						secondBest
						&& chosen.score < 0.62
						&& chosen.score - secondBest.score < 0.035,
					);
					if (isAmbiguous && chosen.score < Math.max(settings.semanticDisplayThreshold, isStrongSingleWordSpan ? 0.48 : 0.56)) {
						continue;
					}

					const replacement = buildReplacement(chosen.targetLink, chosen.targetTitle, span.text);
					semanticCandidates.push({
						id: `${chosen.targetPath}:${span.start}:${span.end}:semantic`,
						sourcePath: file.path,
						targetPath: chosen.targetPath,
						targetTitle: chosen.targetTitle,
						targetLink: chosen.targetLink,
						matchedText: span.text,
						replacement,
						start: span.start,
						end: span.end,
						reason: "semantic",
						confidence: Math.max(0, Math.min(0.96, chosen.score)),
						context: buildContextSnippet(source, span.start, span.end),
						accepted: chosen.score >= settings.semanticAcceptanceThreshold,
						matchType: "semantic",
					});
				}

				const consolidatedSemanticCandidates = collapseSemanticCandidatesByTarget(semanticCandidates);
				consolidatedSemanticCandidates.sort((left, right) =>
					right.confidence - left.confidence || (right.end - right.start) - (left.end - left.start) || left.start - right.start,
				);
				const semanticBudget = getSemanticSuggestionBudget(file.path, file.title);

				for (const candidate of consolidatedSemanticCandidates) {
					if (suggestions.length >= displaySuggestionLimit) {
						break;
					}
					if (semanticBudget > 0 && suggestions.filter((suggestion) => suggestion.matchType === "semantic").length >= semanticBudget) {
						break;
					}
					if (usedTargets.has(candidate.targetPath) || usedTargets.has(candidate.targetLink)) {
						continue;
					}
					if (suggestions.some((suggestion) => rangesOverlap(suggestion.start, suggestion.end, candidate.start, candidate.end))) {
						continue;
					}
					suggestions.push(candidate);
					usedTargets.add(candidate.targetPath);
					usedTargets.add(candidate.targetLink);
				}
			}
		} catch {
			// Semantic matching is opportunistic; deterministic suggestions should still be reviewable.
		}
	}

	suggestions.sort((left, right) => left.start - right.start || left.end - right.end);

	return {
		file: file.file,
		scopeLabel: selection ? "selection" : "current note",
		suggestions,
		source,
		selection,
	};
}

export function applySuggestionsToSource(source: string, suggestions: LinkSuggestion[]): string {
	return [...suggestions]
		.filter((suggestion) => suggestion.accepted)
		.sort((left, right) => right.start - left.start)
		.reduce((current, suggestion) => {
			return `${current.slice(0, suggestion.start)}${suggestion.replacement}${current.slice(suggestion.end)}`;
		}, source);
}

function truncateAnalysisSource(source: string): string {
	if (source.length <= MAX_ANALYSIS_SOURCE_CHARS) {
		return source;
	}
	const truncated = source.slice(0, MAX_ANALYSIS_SOURCE_CHARS);
	const paragraphBreak = truncated.lastIndexOf("\n\n");
	if (paragraphBreak > MAX_ANALYSIS_SOURCE_CHARS * 0.72) {
		return truncated.slice(0, paragraphBreak);
	}
	const lineBreak = truncated.lastIndexOf("\n");
	return lineBreak > MAX_ANALYSIS_SOURCE_CHARS * 0.72 ? truncated.slice(0, lineBreak) : truncated;
}

function buildCandidateLengthsByFirstToken(
	candidates: Map<number, Map<string, PhraseCandidate[]>>,
	maxTokenLength: number,
): Map<string, number[]> {
	const lengthsByFirstToken = new Map<string, Set<number>>();
	for (const [tokenLength, candidateByPhrase] of candidates) {
		if (tokenLength > maxTokenLength) {
			continue;
		}
		for (const candidateList of candidateByPhrase.values()) {
			for (const candidate of candidateList) {
				const firstToken = tokenize(candidate.phrase)[0];
				if (!firstToken) {
					continue;
				}
				const lengths = lengthsByFirstToken.get(firstToken) ?? new Set<number>();
				lengths.add(tokenLength);
				lengthsByFirstToken.set(firstToken, lengths);
			}
		}
	}
	return new Map(
		[...lengthsByFirstToken.entries()].map(([token, lengths]) => [
			token,
			[...lengths].sort((left, right) => right - left),
		]),
	);
}

function buildDescendingRange(max: number, min: number): number[] {
	const values: number[] = [];
	for (let value = max; value >= min; value -= 1) {
		values.push(value);
	}
	return values;
}

function buildAcronymStartLetters(acronymCandidates: Map<string, PhraseCandidate[]>): Set<string> {
	const letters = new Set<string>();
	for (const acronym of acronymCandidates.keys()) {
		const firstLetter = acronym[0];
		if (firstLetter) {
			letters.add(firstLetter);
		}
	}
	return letters;
}

function isLowSignalExactCandidate(
	candidate: PhraseCandidate,
	rawPhrase: string,
	sourceRecord: NoteRecord,
	settings: SemanticAutoLinkerSettings,
): boolean {
	const normalizedPhrase = normalizeText(rawPhrase);
	const lowSignalTargets = new Set((settings.genericTargetTerms ?? FALLBACK_GENERIC_TARGET_TERMS).map(normalizeText));
	if (!lowSignalTargets.has(normalizedPhrase)) {
		return false;
	}
	if (candidate.reason === "acronym") {
		return false;
	}
	if (candidate.note.titleTokens.length > 1 || candidate.note.aliases.length > 1) {
		return false;
	}
	if (sharesFirstFolder(sourceRecord.path, candidate.note.path) && sourceRecord.path !== candidate.note.path) {
		return false;
	}
	return true;
}

function isIgnoredMatchTerm(normalizedPhrase: string, settings: SemanticAutoLinkerSettings): boolean {
	if (!normalizedPhrase) {
		return false;
	}
	const ignoredTerms = settings.ignoredMatchTerms ?? [];
	return ignoredTerms.some((term) => normalizeText(term) === normalizedPhrase);
}

function isStructuralAutoLinkTarget(note: NoteRecord): boolean {
	const normalizedTitle = normalizeText(note.title);
	const normalizedPath = normalizeText(note.path);
	return /^_?index(?:\b|_)/i.test(note.title)
		|| /^index(?:\b|_)/.test(normalizedTitle)
		|| (/\bindex\b/.test(normalizedPath) && /^_?index/i.test(note.title))
		|| /^notes? @\d{2}-\d{2}-\d{2}$/i.test(note.title)
		|| /^\d{4}-\d{2}-\d{2}(?:\b|$)/.test(note.title)
		|| /^lecture \d{4}-\d{2}-\d{2}(?:\b|$)/i.test(note.title)
		|| /^untitled(?: \d+)?$/i.test(note.title)
		|| /^compiled notes?\b/i.test(note.title)
		|| /\blecture notes?\b/i.test(note.title)
		|| /^templates?\//i.test(note.path);
}

function shouldSkipStructuralTarget(note: NoteRecord, settings: SemanticAutoLinkerSettings): boolean {
	if (settings.skipStructuralTargets === false || note.aliases.length > 0) {
		return false;
	}
	const patterns = settings.structuralTargetPatterns ?? [];
	if (patterns.length === 0) {
		return isStructuralAutoLinkTarget(note);
	}
	return patterns.some((pattern) => matchesStructuralPattern(note, pattern));
}

function matchesStructuralPattern(note: NoteRecord, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) {
		return false;
	}
	const regex = wildcardPatternToRegex(trimmed);
	return regex.test(note.title) || regex.test(note.path);
}

function shouldExcludeTarget(note: NoteRecord, settings: SemanticAutoLinkerSettings, excludedTargetPaths: Set<string>): boolean {
	if (excludedTargetPaths.has(note.path)) {
		return true;
	}
	return (settings.excludedTargetPatterns ?? []).some((pattern) => matchesStructuralPattern(note, pattern));
}

function wildcardPatternToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function sharesFirstFolder(leftPath: string, rightPath: string): boolean {
	const leftFolder = leftPath.split("/")[0] ?? "";
	const rightFolder = rightPath.split("/")[0] ?? "";
	return leftFolder.length > 0 && leftFolder === rightFolder && leftPath.includes("/") && rightPath.includes("/");
}

export function collectSemanticQueryCandidatesForSource(
	source: string,
	settings: SemanticAutoLinkerSettings,
	selection?: Range,
): string[] {
	const protectedRanges = getProtectedRanges(source, settings.skipHeadings);
	const tokens = indexTokens(source);
	const occupied = new Array<boolean>(tokens.length).fill(false);
	const selectionStart = selection?.start ?? 0;
	const selectionEnd = selection?.end ?? source.length;
	return buildSemanticSpanCandidates(tokens, source, occupied, protectedRanges, selectionStart, selectionEnd, new Set<string>(), settings)
		.map((span) => span.normalized);
}

function buildDocumentSemanticQuery(
	semanticSpans: SemanticSpanCandidate[],
	source: string,
	settings: SemanticAutoLinkerSettings,
): string {
	const joinedSpans = semanticSpans
		.slice(0, 5)
		.map((span) => span.text.trim())
		.filter(Boolean)
		.join(". ")
		.trim();
	if (joinedSpans) {
		return joinedSpans;
	}
	const fallback = source.replace(/\s+/g, " ").trim();
	return fallback.length <= settings.semanticSummaryLength
		? fallback
		: fallback.slice(0, settings.semanticSummaryLength).trim();
}

async function findDocumentSemanticMatches(
	semanticIndex: SemanticIndex,
	semanticSpans: SemanticSpanCandidate[],
	source: string,
	settings: SemanticAutoLinkerSettings,
	currentPath: string,
): Promise<SemanticQueryMatch[]> {
	const documentQuery = buildDocumentSemanticQuery(semanticSpans, source, settings);
	return documentQuery
		? await semanticIndex.findHybridSimilarNotes(documentQuery, currentPath, Math.max(settings.semanticTopK, 6))
		: [];
}

function getSemanticSuggestionBudget(path: string, title: string): number {
	const normalized = normalizeText(`${path} ${title}`);
	if (/\bbenchmark\b|\bprobe\b|\bfixture\b|\btemplate\b|\bguide\b/.test(normalized)) {
		return 1;
	}
	if (/\bchallenge\b|\bplayground\b/.test(normalized)) {
		return 2;
	}
	return Number.POSITIVE_INFINITY;
}

function buildCandidateMap(
	index: VaultIndex,
	currentPath: string,
	settings: SemanticAutoLinkerSettings,
	excludedTargetPaths: Set<string>,
): Map<number, Map<string, PhraseCandidate[]>> {
	const map = new Map<number, Map<string, PhraseCandidate[]>>();
	const includeAliases = settings.enableAliasMatching;

	for (const note of index.getAll()) {
		if (note.path === currentPath || shouldExcludeTarget(note, settings, excludedTargetPaths)) {
			continue;
		}

		const structuralTarget = shouldSkipStructuralTarget(note, settings);
		if (!structuralTarget) {
			addCandidate(map, note, note.title, "title");
		}
		if (includeAliases) {
			for (const alias of note.aliases) {
				addCandidate(map, note, alias, "alias");
			}
			if (!structuralTarget) {
				for (const implicitAlias of getImplicitAliases(note)) {
					addCandidate(map, note, implicitAlias, "alias");
				}
			}
		}
	}

	for (const [, bucket] of map) {
		for (const [, candidates] of bucket) {
			candidates.sort((left, right) => {
				if (left.reason !== right.reason) {
					return left.reason === "title" ? -1 : 1;
				}
				return right.phrase.length - left.phrase.length;
			});
		}
	}

	return map;
}

function buildAcronymCandidateMap(
	index: VaultIndex,
	currentPath: string,
	settings: SemanticAutoLinkerSettings,
	excludedTargetPaths: Set<string>,
): Map<string, PhraseCandidate[]> {
	const map = new Map<string, PhraseCandidate[]>();
	const includeAliases = settings.enableAliasMatching;

	for (const note of index.getAll()) {
		if (note.path === currentPath || shouldExcludeTarget(note, settings, excludedTargetPaths)) {
			continue;
		}
		if (shouldSkipStructuralTarget(note, settings)) {
			continue;
		}

		const acronymLabels = getAcronymLabels(note, includeAliases);
		if (acronymLabels.size === 0) {
			continue;
		}

		for (const phrase of getAcronymExpansionPhrases(note, includeAliases)) {
			const expansionAcronym = buildPhraseAcronym(phrase);
			if (!expansionAcronym || !acronymLabels.has(expansionAcronym)) {
				continue;
			}
			const candidates = map.get(expansionAcronym) ?? [];
			candidates.push({ note, phrase, reason: "acronym" });
			map.set(expansionAcronym, candidates);
		}
	}

	for (const [, candidates] of map) {
		candidates.sort((left, right) =>
			scoreAcronymCandidate(right) - scoreAcronymCandidate(left)
			|| right.phrase.length - left.phrase.length
			|| left.note.title.localeCompare(right.note.title),
		);
	}

	return map;
}

function getAcronymLabels(note: NoteRecord, includeAliases: boolean): Set<string> {
	const labels = new Set<string>();
	const values = [note.title, ...(includeAliases ? note.aliases : [])];
	for (const value of values) {
		const normalized = normalizeText(value).replace(/\s+/g, "");
		if (!normalized || normalized.length < 3 || normalized.length > 8) {
			continue;
		}
		if (normalized.includes(" ")) {
			continue;
		}
		if (!/[a-z]/.test(normalized)) {
			continue;
		}
		if (tokenize(value).length !== 1) {
			continue;
		}
		labels.add(normalized);
	}
	return labels;
}

function getAcronymExpansionPhrases(note: NoteRecord, includeAliases: boolean): string[] {
	return [note.title, ...(includeAliases ? note.aliases : [])]
		.filter((phrase) => tokenize(phrase).length >= 2);
}

function getImplicitAliases(note: NoteRecord): string[] {
	if (!looksLikePersonRecord(note)) {
		return [];
	}
	const firstToken = note.title.trim().split(/\s+/)[0]?.trim();
	if (!firstToken) {
		return [];
	}
	const normalizedFirstToken = normalizeText(firstToken);
	if (!normalizedFirstToken) {
		return [];
	}
	if (note.lookupKeys.includes(normalizedFirstToken)) {
		return [];
	}
	return [firstToken];
}

const NON_NAME_TOKENS = new Set([
	"analysis", "backends", "benchmark", "brief", "checklist", "concept", "concepts", "connections", "garden",
	"graph", "inference", "knowledge", "learning", "management", "market", "models", "network", "networks",
	"notes", "pages", "pca", "pkm", "positioning", "preview", "release", "review", "session", "workflow",
]);

function looksLikePersonRecord(note: NoteRecord): boolean {
	if (/(^|\/)(people|person|contacts|team|staff|members?)\//i.test(note.path)) {
		return true;
	}
	const parts = note.title.trim().split(/\s+/);
	if (parts.length !== 2) {
		return false;
	}
	const [firstPart, secondPart] = parts;
	if (!firstPart || !secondPart) {
		return false;
	}
	if (!/^[A-Z][a-z]+(?:['-][A-Z][a-z]+)?$/.test(firstPart) || !/^[A-Z][a-z]+(?:['-][A-Z][a-z]+)?$/.test(secondPart)) {
		return false;
	}
	return parts.every((part) => !NON_NAME_TOKENS.has(part.toLowerCase()));
}

function addCandidate(
	map: Map<number, Map<string, PhraseCandidate[]>>,
	note: NoteRecord,
	phrase: string,
	reason: string,
): void {
	const key = normalizeText(phrase);
	if (!key) {
		return;
	}

	const length = key.split(" ").length;
	const bucket = map.get(length) ?? new Map<string, PhraseCandidate[]>();
	const candidates = bucket.get(key) ?? [];
	candidates.push({ note, phrase, reason });
	bucket.set(key, candidates);
	const compactKey = compactNormalizeText(phrase);
	if (compactKey && compactKey !== key) {
		const compactCandidates = bucket.get(compactKey) ?? [];
		compactCandidates.push({ note, phrase, reason });
		bucket.set(compactKey, compactCandidates);
	}
	map.set(length, bucket);
}

function getAcronymCandidatesForSpan(
	acronymCandidates: Map<string, PhraseCandidate[]>,
	tokens: ReturnType<typeof indexTokens>,
	startIndex: number,
	endIndex: number,
): PhraseCandidate[] {
	const acronym = buildTokenAcronym(tokens, startIndex, endIndex);
	if (!acronym) {
		return [];
	}
	return acronymCandidates.get(acronym) ?? [];
}

function buildTokenAcronym(tokens: ReturnType<typeof indexTokens>, startIndex: number, endIndex: number): string | null {
	const parts: string[] = [];
	for (let index = startIndex; index <= endIndex; index += 1) {
		const token = tokens[index]?.normalized;
		if (!token || STOP_WORDS.has(token)) {
			continue;
		}
		const first = token[0];
		if (!first) {
			continue;
		}
		parts.push(first.toLowerCase());
	}
	return parts.length >= 2 ? parts.join("") : null;
}

function buildPhraseAcronym(phrase: string): string | null {
	const parts = tokenize(phrase).filter((part) => part.length > 0 && !STOP_WORDS.has(part));
	if (parts.length < 2) {
		return null;
	}
	return parts.map((part) => part[0]?.toLowerCase() ?? "").join("");
}

function scoreAcronymCandidate(candidate: PhraseCandidate): number {
	let score = 0;
	const normalizedPhrase = normalizeText(candidate.phrase);
	if (candidate.reason === "acronym") {
		score += 2;
	}
	if (normalizedPhrase === candidate.note.normalizedTitle) {
		score += 1;
	}
	if (candidate.note.aliases.includes(candidate.phrase)) {
		score += 0.5;
	}
	return score;
}

function extractExistingTargets(source: string): string[] {
	return Array.from(source.matchAll(/\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?]]/g), (match) =>
		match[1]?.trim() ?? "",
	).filter(Boolean);
}

export function buildReplacement(targetLink: string, targetTitle: string, matchedText: string): string {
	if (normalizeText(matchedText) === normalizeText(targetTitle)) {
		return `[[${targetTitle}]]`;
	}
	return `[[${targetLink}|${matchedText}]]`;
}

function isAnyOccupied(occupied: boolean[], start: number, end: number): boolean {
	for (let index = start; index <= end; index += 1) {
		if (occupied[index]) {
			return true;
		}
	}
	return false;
}

function markOccupied(occupied: boolean[], start: number, end: number): void {
	for (let index = start; index <= end; index += 1) {
		occupied[index] = true;
	}
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
	return leftStart < rightEnd && rightStart < leftEnd;
}

function collapseSemanticCandidatesByTarget(candidates: LinkSuggestion[]): LinkSuggestion[] {
	const bestByTarget = new Map<string, LinkSuggestion>();

	for (const candidate of candidates) {
		const current = bestByTarget.get(candidate.targetPath);
		if (!current) {
			bestByTarget.set(candidate.targetPath, candidate);
			continue;
		}
		bestByTarget.set(candidate.targetPath, pickBetterSemanticCandidate(current, candidate));
	}

	return [...bestByTarget.values()];
}

function pickBetterSemanticCandidate(left: LinkSuggestion, right: LinkSuggestion): LinkSuggestion {
	const confidenceDelta = Math.abs(left.confidence - right.confidence);
	const leftLength = left.end - left.start;
	const rightLength = right.end - right.start;

	if (confidenceDelta <= 0.06 && leftLength !== rightLength) {
		return rightLength > leftLength ? right : left;
	}
	if (right.confidence !== left.confidence) {
		return right.confidence > left.confidence ? right : left;
	}
	if (rightLength !== leftLength) {
		return rightLength > leftLength ? right : left;
	}
	return right.start < left.start ? right : left;
}

interface SemanticSpanCandidate {
	text: string;
	normalized: string;
	start: number;
	end: number;
	tokenStartIndex: number;
	tokenEndIndex: number;
	standaloneLine: boolean;
}

const STOP_WORDS = new Set([
	"a", "an", "the", "and", "for", "with", "that", "this", "into", "from", "over", "under", "about", "of", "some", "these", "those",
	"their", "there", "while", "where", "which", "should", "could", "would", "have", "has", "had", "been", "being",
	"than", "then", "they", "them", "will", "just", "also", "very", "more", "most", "does", "did", "into", "onto",
	"is", "are", "was", "were", "be",
]);
const META_SPAN_WORDS = new Set([
	"semantic", "note", "notes", "title", "titles", "match", "matching", "overlap", "review", "suggestion", "target",
	"targets", "benchmark", "map", "guide", "playground", "fixture", "future", "today", "deterministic",
	"concept", "concepts",
]);
const LOW_SIGNAL_PREFIX_WORDS = new Set([
	"it", "this", "that", "talk", "about", "meant", "stress", "broader", "goal", "turn", "keep", "getting",
	"without", "naming", "exact", "destination", "direct", "rather", "than",
	"discuss", "pair", "pairs", "good", "hard", "later", "mostly", "one", "way", "place", "still",
]);

function buildSemanticSpanCandidates(
	tokens: ReturnType<typeof indexTokens>,
	source: string,
	occupied: boolean[],
	protectedRanges: Range[],
	selectionStart: number,
	selectionEnd: number,
	singleWordHints: Set<string>,
	settings: SemanticAutoLinkerSettings,
): SemanticSpanCandidate[] {
	const spans: SemanticSpanCandidate[] = [];
	const seen = new Set<string>();
	const maxWindows = 16;
	const maxGeneratedWindows = 48;
	const tokenLengths = [4, 3, 2, 1];

	for (let startIndex = 0; startIndex < tokens.length; startIndex += 1) {
		const startToken = tokens[startIndex];
		if (!startToken || occupied[startIndex] || startToken.start < selectionStart || startToken.end > selectionEnd) {
			continue;
		}
		for (const tokenLength of tokenLengths) {
			const endIndex = startIndex + tokenLength - 1;
			const endToken = tokens[endIndex];
			if (!endToken) {
				continue;
			}
			if (endToken.end > selectionEnd || isAnyOccupied(occupied, startIndex, endIndex)) {
				continue;
			}
			if (overlapsRange(startToken.start, endToken.end, protectedRanges)) {
				continue;
			}
			if (containsSentenceBoundary(source, startToken.start, endToken.end)) {
				continue;
			}
			const trimmed = trimSemanticSpan(tokens, startIndex, endIndex, source);
			if (!trimmed) {
				continue;
			}
			const { text, normalized, tokenStartIndex, tokenEndIndex, start, end, standaloneLine } = trimmed;
			if (hasInternalStopWords(normalized) && tokenLength > 2) {
				continue;
			}
			if (!normalized || seen.has(normalized) || isIgnoredMatchTerm(normalized, settings) || isLowSignalSemanticSpan(normalized)) {
				continue;
			}
			if (tokenLength === 1 && !isStrongSingleWordSemanticSpan(normalized, singleWordHints)) {
				continue;
			}
			spans.push({
				text,
				normalized,
				start,
				end,
				tokenStartIndex,
				tokenEndIndex,
				standaloneLine,
			});
			seen.add(normalized);
			if (spans.length >= maxGeneratedWindows) {
				return spans
					.sort((left, right) =>
						scoreSemanticSpanCandidate(right) - scoreSemanticSpanCandidate(left)
						|| left.start - right.start
						|| (right.end - right.start) - (left.end - left.start),
					)
					.slice(0, maxWindows);
			}
			break;
		}
	}

	return spans
		.sort((left, right) =>
			scoreSemanticSpanCandidate(right) - scoreSemanticSpanCandidate(left)
			|| left.start - right.start
			|| (right.end - right.start) - (left.end - left.start),
		)
		.slice(0, maxWindows);
}

function isLowSignalSemanticSpan(normalized: string): boolean {
	const parts = normalized.split(" ").filter(Boolean);
	if (parts.length < 2) {
		return !isStrongSingleWordSemanticSpan(normalized, new Set<string>());
	}
	const contentWords = parts.filter((part) => part.length > 2 && !STOP_WORDS.has(part));
	if (contentWords.length < 2) {
		return true;
	}
	const metaWords = parts.filter((part) => META_SPAN_WORDS.has(part));
	if (metaWords.length >= 2 || (metaWords.length > 0 && contentWords.length <= 2)) {
		return true;
	}
	if (STOP_WORDS.has(parts[0] ?? "") || STOP_WORDS.has(parts[parts.length - 1] ?? "")) {
		return true;
	}
	return false;
}

function isStrongSingleWordSemanticSpan(normalized: string, singleWordHints: Set<string>): boolean {
	if (!normalized || normalized.includes(" ")) {
		return false;
	}
	if (STOP_WORDS.has(normalized) || META_SPAN_WORDS.has(normalized) || LOW_SIGNAL_PREFIX_WORDS.has(normalized)) {
		return false;
	}
	if (singleWordHints.has(normalized)) {
		return true;
	}
	if (/^\d+$/.test(normalized)) {
		return false;
	}
	return normalized.length >= 5 || normalized.includes("-");
}

function hasInternalStopWords(normalized: string): boolean {
	const parts = normalized.split(" ").filter(Boolean);
	if (parts.length <= 2) {
		return false;
	}
	return parts.slice(1, -1).some((part) => STOP_WORDS.has(part) || LOW_SIGNAL_PREFIX_WORDS.has(part));
}

function buildSemanticSingleWordHints(index: VaultIndex, currentPath: string, settings: SemanticAutoLinkerSettings, excludedTargetPaths: Set<string>): Set<string> {
	const hints = new Set<string>();
	for (const note of index.getAll()) {
		if (note.path === currentPath || shouldExcludeTarget(note, settings, excludedTargetPaths) || !looksLikePersonRecord(note)) {
			continue;
		}
		const firstToken = note.titleTokens[0];
		if (!firstToken || firstToken.length < 3) {
			continue;
		}
		if (STOP_WORDS.has(firstToken) || META_SPAN_WORDS.has(firstToken) || LOW_SIGNAL_PREFIX_WORDS.has(firstToken)) {
			continue;
		}
		hints.add(firstToken);
	}
	return hints;
}

function containsSentenceBoundary(source: string, start: number, end: number): boolean {
	const window = source.slice(start, end);
	return /[.!?,;\n]/.test(window);
}

function trimSemanticSpan(
	tokens: ReturnType<typeof indexTokens>,
	startIndex: number,
	endIndex: number,
	source: string,
): SemanticSpanCandidate | null {
	let nextStart = startIndex;
	let nextEnd = endIndex;

	while (nextStart <= nextEnd) {
		const token = tokens[nextStart];
		if (!token) {
			return null;
		}
		if (!STOP_WORDS.has(token.normalized) && !META_SPAN_WORDS.has(token.normalized) && !LOW_SIGNAL_PREFIX_WORDS.has(token.normalized)) {
			break;
		}
		nextStart += 1;
	}

	while (nextEnd >= nextStart) {
		const token = tokens[nextEnd];
		if (!token) {
			return null;
		}
		if (!STOP_WORDS.has(token.normalized) && !META_SPAN_WORDS.has(token.normalized) && !LOW_SIGNAL_PREFIX_WORDS.has(token.normalized)) {
			break;
		}
		nextEnd -= 1;
	}

	if (nextEnd - nextStart + 1 < 1) {
		return null;
	}

	const startToken = tokens[nextStart];
	const endToken = tokens[nextEnd];
	if (!startToken || !endToken) {
		return null;
	}

	const text = source.slice(startToken.start, endToken.end).trim().replace(/^[,:\-–—\s]+|[,:\-–—\s]+$/g, "");
	const normalized = normalizeText(text);
	if (!normalized) {
		return null;
	}

	return {
		text,
		normalized,
		start: startToken.start,
		end: endToken.end,
		tokenStartIndex: nextStart,
		tokenEndIndex: nextEnd,
		standaloneLine: isStandaloneLineSpan(source, startToken.start, endToken.end, text),
	};
}

function scoreSemanticSpanCandidate(span: SemanticSpanCandidate): number {
	const parts = span.normalized.split(" ").filter(Boolean);
	const contentWords = parts.filter((part) => part.length > 2 && !STOP_WORDS.has(part) && !META_SPAN_WORDS.has(part));
	const longWordCount = contentWords.filter((part) => part.length >= 7).length;
	const hyphenBonus = span.text.includes("-") ? 0.4 : 0;
	const singleWordBonus = parts.length === 1 && isStrongSingleWordSemanticSpan(parts[0] ?? "", new Set<string>()) ? 2.8 : 0;
	const standaloneBonus = span.standaloneLine ? (parts.length <= 3 ? 2.2 : 1.1) : 0;
	return (contentWords.length * 2) + longWordCount + hyphenBonus + singleWordBonus + standaloneBonus + Math.min(span.text.length / 24, 1.2);
}

function isStandaloneLineSpan(source: string, start: number, end: number, text: string): boolean {
	const lineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const nextNewline = source.indexOf("\n", end);
	const lineEnd = nextNewline === -1 ? source.length : nextNewline;
	const lineText = source.slice(lineStart, lineEnd).trim();
	return Boolean(lineText) && lineText === text.trim();
}
