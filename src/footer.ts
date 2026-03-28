import type { NoteRecord, RelatedNoteSuggestion, SemanticAutoLinkerSettings } from "./types";
import { VaultIndex } from "./vault-index";

export function buildSeeAlsoSuggestions(
	current: NoteRecord,
	index: VaultIndex,
	linkedTargets: Set<string>,
	settings: SemanticAutoLinkerSettings,
): RelatedNoteSuggestion[] {
	const currentTokens = new Set(current.titleTokens);
	const currentTags = new Set(current.tags);

	return index
		.getAll()
		.filter((note) => note.path !== current.path && !linkedTargets.has(note.linkTarget) && !linkedTargets.has(note.path))
		.map((note) => {
			const sharedTokens = note.titleTokens.filter((token) => currentTokens.has(token)).length;
			const sharedTags = note.tags.filter((tag) => currentTags.has(tag)).length;
			const score = sharedTokens * 2 + sharedTags * 3;
			const reasons: string[] = [];
			if (sharedTokens > 0) {
				reasons.push(`${sharedTokens} shared title token${sharedTokens === 1 ? "" : "s"}`);
			}
			if (sharedTags > 0) {
				reasons.push(`${sharedTags} shared tag${sharedTags === 1 ? "" : "s"}`);
			}
			return {
				targetPath: note.path,
				targetTitle: note.title,
				targetLink: note.linkTarget,
				score,
				reason: reasons.join(", "),
				previewText: reasons.join(", "),
				matchType: "deterministic" as const,
			};
		})
		.filter((note) => note.score > 0)
		.sort((left, right) => right.score - left.score || left.targetTitle.localeCompare(right.targetTitle))
		.slice(0, settings.seeAlsoCount);
}

export function upsertSeeAlsoSection(
	source: string,
	suggestions: RelatedNoteSuggestion[],
	settings: SemanticAutoLinkerSettings,
	useDisplayTitle = false,
): string {
	if (suggestions.length === 0) {
		return source;
	}

	const heading = `## ${settings.seeAlsoHeading}`;
	const body = suggestions.map((suggestion) => `- ${formatSeeAlsoLink(suggestion, useDisplayTitle)}`).join("\n");
	const section = `${heading}\n${body}`;
	const sectionRegex = new RegExp(`(^|\\n)## ${escapeRegex(settings.seeAlsoHeading)}\\n[\\s\\S]*?(?=\\n## |$)`, "m");

	if (sectionRegex.test(source)) {
		return source.replace(sectionRegex, `\n${section}`);
	}

	const trimmed = source.replace(/\s*$/, "");
	return `${trimmed}\n\n${section}\n`;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatSeeAlsoLink(suggestion: RelatedNoteSuggestion, useDisplayTitle: boolean): string {
	if (!useDisplayTitle) {
		return `[[${suggestion.targetLink}]]`;
	}

	const normalizedLink = suggestion.targetLink.trim();
	const normalizedTitle = suggestion.targetTitle.trim();
	if (!normalizedTitle || normalizedLink === normalizedTitle) {
		return `[[${normalizedLink}]]`;
	}

	return `[[${normalizedLink}|${normalizedTitle}]]`;
}
