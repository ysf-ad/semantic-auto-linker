const TOKEN_REGEX = /[\p{L}\p{N}+#]+(?:[.'’_-][\p{L}\p{N}+#]+)*/gu;

export interface IndexedToken {
	value: string;
	normalized: string;
	start: number;
	end: number;
}

export function normalizeText(value: string): string {
	return tokenize(value).join(" ").trim();
}

export function compactNormalizeText(value: string): string {
	return normalizeText(value).replace(/[^a-z0-9+#]+/g, "");
}

export function tokenize(value: string): string[] {
	return Array.from(value.matchAll(TOKEN_REGEX), (match) => normalizeToken(match[0])).filter(Boolean);
}

export function indexTokens(value: string): IndexedToken[] {
	return Array.from(value.matchAll(TOKEN_REGEX), (match) => {
		const raw = match[0];
		const start = match.index ?? 0;
		return {
			value: raw,
			normalized: normalizeToken(raw),
			start,
			end: start + raw.length,
		};
	}).filter((token) => token.normalized.length > 0);
}

export function normalizePathToLink(path: string): string {
	return path.replace(/\.md$/i, "");
}

export function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

export function splitMultilineSetting(value: string): string[] {
	return uniqueStrings(
		value
			.split(/\r?\n|,/)
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

export function formatMultilineSetting(values: string[]): string {
	return values.join("\n");
}

export function buildContextSnippet(source: string, start: number, end: number, radius = 45): string {
	const prefix = source.slice(Math.max(0, start - radius), start).replace(/\s+/g, " ");
	const match = source.slice(start, end).replace(/\s+/g, " ");
	const suffix = source.slice(end, Math.min(source.length, end + radius)).replace(/\s+/g, " ");
	return `${prefix}${match}${suffix}`.trim();
}

function normalizeToken(value: string): string {
	const lower = value.toLowerCase().replace(/[’']/g, "");
	const cleaned = lower.replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/g, "");
	return singularize(cleaned);
}

function singularize(value: string): string {
	if (value.length <= 3) {
		return value;
	}
	if (value.endsWith("ies") && value.length > 4) {
		return `${value.slice(0, -3)}y`;
	}
	if (value.endsWith("sses")) {
		return value.slice(0, -2);
	}
	if (value.endsWith("ses") || value.endsWith("xes")) {
		return value.slice(0, -2);
	}
	if (value.endsWith("s") && !value.endsWith("ss")) {
		return value.slice(0, -1);
	}
	return value;
}
