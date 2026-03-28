import type { Range } from "./types";

const FENCED_BLOCK_REGEX = /^(```|~~~).*$/gm;
const INLINE_CODE_REGEX = /(`+)([^`]*?)\1/g;
const WIKILINK_REGEX = /\[\[[^[\]]+]]/g;
const MARKDOWN_LINK_REGEX = /!?\[[^[\]]+]\([^)]+\)/g;

export function getProtectedRanges(source: string, skipHeadings: boolean): Range[] {
	const ranges: Range[] = [];

	const frontmatterRange = getFrontmatterRange(source);
	if (frontmatterRange) {
		ranges.push(frontmatterRange);
	}

	for (const range of getFencedCodeRanges(source)) {
		ranges.push(range);
	}

	pushRegexRanges(source, INLINE_CODE_REGEX, ranges);
	pushRegexRanges(source, WIKILINK_REGEX, ranges);
	pushRegexRanges(source, MARKDOWN_LINK_REGEX, ranges);

	if (skipHeadings) {
		ranges.push(...getHeadingRanges(source));
	}

	return mergeRanges(ranges);
}

export function overlapsRange(start: number, end: number, ranges: Range[]): boolean {
	return ranges.some((range) => start < range.end && end > range.start);
}

function getFrontmatterRange(source: string): Range | null {
	if (!source.startsWith("---")) {
		return null;
	}

	const closingMatch = source.slice(3).match(/\r?\n---\r?\n?/);
	if (!closingMatch || closingMatch.index === undefined) {
		return null;
	}

	const end = 3 + closingMatch.index + closingMatch[0].length;
	return { start: 0, end };
}

function getFencedCodeRanges(source: string): Range[] {
	const lines = Array.from(source.matchAll(FENCED_BLOCK_REGEX));
	const ranges: Range[] = [];

	for (let index = 0; index < lines.length; index += 2) {
		const startMatch = lines[index];
		const endMatch = lines[index + 1];
		if (!startMatch || startMatch.index === undefined) {
			continue;
		}
		const start = startMatch.index;
		const end = endMatch && endMatch.index !== undefined
			? endMatch.index + endMatch[0].length
			: source.length;
		ranges.push({ start, end });
	}

	return ranges;
}

function getHeadingRanges(source: string): Range[] {
	const ranges: Range[] = [];
	let offset = 0;

	for (const line of source.split(/\r?\n/)) {
		if (line.startsWith("#")) {
			ranges.push({ start: offset, end: offset + line.length });
		}
		offset += line.length + 1;
	}

	return ranges;
}

function pushRegexRanges(source: string, regex: RegExp, ranges: Range[]): void {
	for (const match of source.matchAll(regex)) {
		if (match.index === undefined) {
			continue;
		}
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}
}

function mergeRanges(ranges: Range[]): Range[] {
	const sorted = [...ranges].sort((left, right) => left.start - right.start);
	if (sorted.length === 0) {
		return [];
	}

	const first = sorted[0];
	if (!first) {
		return [];
	}

	const merged: Range[] = [{ ...first }];
	for (let index = 1; index < sorted.length; index += 1) {
		const current = sorted[index];
		const previous = merged[merged.length - 1];
		if (!current || !previous) {
			continue;
		}
		if (current.start <= previous.end) {
			previous.end = Math.max(previous.end, current.end);
			continue;
		}
		merged.push({ ...current });
	}

	return merged;
}
