import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";
import { createDevVaultHarness } from "./dev-vault-harness.mjs";

const jiti = createJiti(import.meta.url);
const { analyzeNoteContent } = await jiti.import("../src/matcher.ts");

test("semantic challenge note keeps strong deterministic matches and avoids benchmark/meta targets", async () => {
	const harness = await createDevVaultHarness();
	const analysis = await harness.analyzeNote("Semantic Challenge Note.md");
	const targetTitles = analysis.suggestions.map((suggestion) => suggestion.targetTitle);

	assert.ok(targetTitles.includes("On-Device Models"));
	assert.ok(targetTitles.includes("Pluggable Backends"));
	assert.ok(!targetTitles.includes("Semantic Benchmark Map"));
});

test("semantic suggestions use tighter anchors", async () => {
	const harness = await createDevVaultHarness();
	const analysis = await harness.analyzeNote("Semantic Challenge Note.md");
	const semanticSuggestions = analysis.suggestions.filter((suggestion) => suggestion.matchType === "semantic");

	assert.ok(semanticSuggestions.length > 0, "expected at least one semantic suggestion");
	for (const suggestion of semanticSuggestions) {
		assert.ok(!/[.]/.test(suggestion.matchedText), `semantic anchor crossed sentence boundary: ${suggestion.matchedText}`);
		assert.ok(!/^it\b/i.test(suggestion.matchedText), `semantic anchor kept low-signal prefix: ${suggestion.matchedText}`);
		assert.ok(!/^this\b/i.test(suggestion.matchedText), `semantic anchor kept low-signal prefix: ${suggestion.matchedText}`);
	}
});

test("current-note semantic matching catches strong single-word sports anchors", async () => {
	const harness = await createDevVaultHarness();
	const neuralNetworks = await harness.analyzeNote("Neural Networks.md");
	const tennisProbe = await harness.analyzeNote("Semantic Playground/Tennis Single Word Probe.md");

	const neuralTargets = new Set(
		neuralNetworks.suggestions
			.filter((suggestion) => suggestion.matchType === "semantic")
			.map((suggestion) => suggestion.targetTitle),
	);
	const probeSemanticSuggestions = tennisProbe.suggestions.filter((suggestion) => suggestion.matchType === "semantic");
	const probeTargets = new Set(probeSemanticSuggestions.map((suggestion) => suggestion.targetTitle));
	const probeTargetPaths = new Set(probeSemanticSuggestions.map((suggestion) => suggestion.targetPath));

	assert.ok(
		neuralTargets.has("Topspin Forehand"),
		`expected 'forehand' to surface Topspin Forehand, got ${[...neuralTargets].join(", ")}`,
	);
	assert.ok(
		probeSemanticSuggestions.some((suggestion) => suggestion.matchedText.toLowerCase() === "tennis"),
		`expected tennis probe to produce a single-word sports anchor, got ${probeSemanticSuggestions.map((suggestion) => suggestion.matchedText).join(", ")}`,
	);
	assert.ok(
		[...probeTargetPaths].some((path) => path.startsWith("Hobbies/Tennis/")),
		`expected tennis probe to surface a tennis note, got ${[...probeTargets].join(", ")}`,
	);
});

test("current-note analysis handles abbreviations and person aliases cleanly", async () => {
	const harness = await createDevVaultHarness();
	const analysis = await harness.analyzeNote("Semantic Playground/Acronym And Name Probe.md");
	const suggestionByMatch = new Map(analysis.suggestions.map((suggestion) => [suggestion.matchedText.toLowerCase(), suggestion]));

	const alexSuggestion = suggestionByMatch.get("alex");
	assert.ok(alexSuggestion, "expected alex suggestion");
	assert.equal(alexSuggestion?.targetTitle, "Alex Chen");
	assert.equal(alexSuggestion?.matchType, "alias");

	const pcaSuggestion = suggestionByMatch.get("principle component analysis");
	assert.ok(pcaSuggestion, "expected principle component analysis suggestion");
	assert.equal(pcaSuggestion?.targetTitle, "PCA");
	assert.ok(["semantic", "acronym"].includes(pcaSuggestion?.matchType ?? ""), `unexpected PCA match type: ${pcaSuggestion?.matchType}`);
});

test("acronym expansion beats incidental phrase mentions", async () => {
	const sourceRecord = {
		file: {
			path: "Scratch.md",
			fullPath: "Scratch.md",
			basename: "Scratch",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Scratch.md",
		linkTarget: "Scratch",
		title: "Scratch",
		aliases: [],
		normalizedTitle: "scratch",
		titleTokens: ["scratch"],
		lookupKeys: ["scratch"],
		tags: [],
	};
	const pcaRecord = {
		file: {
			path: "PCA.md",
			fullPath: "PCA.md",
			basename: "PCA",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "PCA.md",
		linkTarget: "PCA",
		title: "PCA",
		aliases: ["Principal Component Analysis"],
		normalizedTitle: "pca",
		titleTokens: ["pca"],
		lookupKeys: ["pca", "principal component analysis"],
		tags: [],
	};
	const cxxPrimerRecord = {
		file: {
			path: "C++ Primer.md",
			fullPath: "C++ Primer.md",
			basename: "C++ Primer",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "C++ Primer.md",
		linkTarget: "C++ Primer",
		title: "C++ Primer",
		aliases: [],
		normalizedTitle: "c++ primer",
		titleTokens: ["c++", "primer"],
		lookupKeys: ["c++ primer"],
		tags: [],
	};
	const index = {
		getAll() {
			return [sourceRecord, pcaRecord, cxxPrimerRecord];
		},
	};
	const settings = {
		firstOccurrenceOnly: true,
		maxLinksPerNote: 12,
		excludedFolders: [],
		excludedFiles: [],
		enableAliasMatching: true,
		skipHeadings: true,
		seeAlsoHeading: "See also",
		seeAlsoCount: 5,
		semanticMode: false,
		semanticProviderId: "ollama",
		semanticTopK: 8,
		semanticSummaryLength: 280,
		semanticTransformersModel: "Xenova/all-MiniLM-L6-v2",
		semanticOllamaBaseUrl: "http://127.0.0.1:11434",
		semanticOllamaModel: "embeddinggemma",
		semanticProjectionMetric: "cosine",
		semanticExplorerLabelDistance: 620,
		semanticDisplayThreshold: 0.3,
		semanticAcceptanceThreshold: 0.6,
		autoRefreshEnabled: true,
		autoRefreshMinutes: 60,
	};
	const analysis = await analyzeNoteContent(
		sourceRecord,
		"principle component analysis should be surfaced here.",
		index,
		settings,
		undefined,
	);
	const suggestion = analysis.suggestions.find((item) => item.matchedText.toLowerCase() === "principle component analysis");

	assert.ok(suggestion, "expected acronym expansion suggestion");
	assert.equal(suggestion?.targetTitle, "PCA");
	assert.equal(suggestion?.matchType, "acronym");
});

test("exact title replacements use display title instead of full path", async () => {
	const sourceRecord = {
		file: {
			path: "Scratch.md",
			fullPath: "Scratch.md",
			basename: "Scratch",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Scratch.md",
		linkTarget: "Scratch",
		title: "Scratch",
		aliases: [],
		normalizedTitle: "scratch",
		titleTokens: ["scratch"],
		lookupKeys: ["scratch"],
		tags: [],
	};
	const targetRecord = {
		file: {
			path: "Research/ML/Embeddings.md",
			fullPath: "Research/ML/Embeddings.md",
			basename: "Embeddings",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Research/ML/Embeddings.md",
		linkTarget: "Research/ML/Embeddings",
		title: "Embeddings",
		aliases: ["dense vectors"],
		normalizedTitle: "embedding",
		titleTokens: ["embedding"],
		lookupKeys: ["embedding", "dense vector"],
		tags: [],
	};
	const index = {
		getAll() {
			return [sourceRecord, targetRecord];
		},
	};
	const settings = {
		firstOccurrenceOnly: true,
		maxLinksPerNote: 12,
		excludedFolders: [],
		excludedFiles: [],
		enableAliasMatching: true,
		skipHeadings: true,
		seeAlsoHeading: "See also",
		seeAlsoCount: 5,
		semanticMode: false,
		semanticProviderId: "ollama",
		semanticTopK: 8,
		semanticSummaryLength: 280,
		semanticTransformersModel: "Xenova/all-MiniLM-L6-v2",
		semanticOllamaBaseUrl: "http://127.0.0.1:11434",
		semanticOllamaModel: "embeddinggemma",
		semanticProjectionMetric: "cosine",
		semanticExplorerLabelDistance: 620,
		semanticDisplayThreshold: 0.3,
		semanticAcceptanceThreshold: 0.6,
		autoRefreshEnabled: true,
		autoRefreshMinutes: 60,
	};
	const exactAnalysis = await analyzeNoteContent(sourceRecord, "Embeddings are useful.", index, settings, undefined);
	const aliasAnalysis = await analyzeNoteContent(sourceRecord, "dense vectors are useful.", index, settings, undefined);

	assert.equal(exactAnalysis.suggestions[0]?.replacement, "[[Embeddings]]");
	assert.equal(aliasAnalysis.suggestions[0]?.replacement, "[[Research/ML/Embeddings|dense vectors]]");
});

test("exact phrase matching can be disabled independently", async () => {
	const sourceRecord = {
		file: {
			path: "Scratch.md",
			fullPath: "Scratch.md",
			basename: "Scratch",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Scratch.md",
		linkTarget: "Scratch",
		title: "Scratch",
		aliases: [],
		normalizedTitle: "scratch",
		titleTokens: ["scratch"],
		lookupKeys: ["scratch"],
		tags: [],
	};
	const targetRecord = {
		file: {
			path: "Research/ML/Embeddings.md",
			fullPath: "Research/ML/Embeddings.md",
			basename: "Embeddings",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Research/ML/Embeddings.md",
		linkTarget: "Research/ML/Embeddings",
		title: "Embeddings",
		aliases: ["dense vectors"],
		normalizedTitle: "embedding",
		titleTokens: ["embedding"],
		lookupKeys: ["embedding", "dense vector"],
		tags: [],
	};
	const index = {
		getAll() {
			return [sourceRecord, targetRecord];
		},
	};
	const settings = {
		firstOccurrenceOnly: true,
		maxLinksPerNote: 12,
		excludedFolders: [],
		excludedFiles: [],
		excludedTargetFiles: [],
		enableExactMatching: false,
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

	const analysis = await analyzeNoteContent(sourceRecord, "Embeddings and dense vectors are useful.", index, settings, undefined);

	assert.equal(analysis.suggestions.length, 0);
});

test("semantic suggestions can be disabled independently", async () => {
	const harness = await createDevVaultHarness();
	harness.settings.enableSemanticSuggestions = false;
	const analysis = await harness.analyzeNote("Semantic Challenge Note.md");

	assert.equal(analysis.suggestions.some((suggestion) => suggestion.matchType === "semantic"), false);
	assert.ok(analysis.suggestions.some((suggestion) => suggestion.matchType !== "semantic"), "expected deterministic suggestions to remain enabled");
});

test("excluded target files are not suggested as deterministic matches", async () => {
	const sourceRecord = {
		file: {
			path: "Scratch.md",
			fullPath: "Scratch.md",
			basename: "Scratch",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Scratch.md",
		linkTarget: "Scratch",
		title: "Scratch",
		aliases: [],
		normalizedTitle: "scratch",
		titleTokens: ["scratch"],
		lookupKeys: ["scratch"],
		tags: [],
	};
	const noisyTargetRecord = {
		file: {
			path: "Files.md",
			fullPath: "Files.md",
			basename: "Files",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Files.md",
		linkTarget: "Files",
		title: "Files",
		aliases: ["file"],
		normalizedTitle: "file",
		titleTokens: ["file"],
		lookupKeys: ["file"],
		tags: [],
	};
	const index = {
		getAll() {
			return [sourceRecord, noisyTargetRecord];
		},
	};
	const settings = {
		firstOccurrenceOnly: true,
		maxLinksPerNote: 12,
		excludedFolders: [],
		excludedFiles: [],
		excludedTargetFiles: ["Files.md"],
		enableAliasMatching: true,
		skipHeadings: true,
		seeAlsoHeading: "See also",
		seeAlsoCount: 5,
		semanticMode: false,
		semanticProviderId: "ollama",
		semanticTopK: 8,
		semanticSummaryLength: 280,
		semanticTransformersModel: "Xenova/all-MiniLM-L6-v2",
		semanticOllamaBaseUrl: "http://127.0.0.1:11434",
		semanticOllamaModel: "embeddinggemma",
		semanticProjectionMetric: "cosine",
		semanticExplorerLabelDistance: 620,
		semanticDisplayThreshold: 0.3,
		semanticAcceptanceThreshold: 0.6,
		autoRefreshEnabled: true,
		autoRefreshMinutes: 60,
	};

	const analysis = await analyzeNoteContent(
		sourceRecord,
		"Files and file references should not all become noisy links.",
		index,
		settings,
		undefined,
	);

	assert.equal(analysis.suggestions.length, 0);
});

test("current-note analysis falls back to first-name matching for person-title notes without explicit aliases", async () => {
	const sourceRecord = {
		file: {
			path: "Scratch.md",
			fullPath: "Scratch.md",
			basename: "Scratch",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Scratch.md",
		linkTarget: "Scratch",
		title: "Scratch",
		aliases: [],
		normalizedTitle: "scratch",
		titleTokens: ["scratch"],
		lookupKeys: ["scratch"],
		tags: [],
	};
	const alexRecord = {
		file: {
			path: "People/Alex Chen.md",
			fullPath: "People/Alex Chen.md",
			basename: "Alex Chen",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "People/Alex Chen.md",
		linkTarget: "People/Alex Chen",
		title: "Alex Chen",
		aliases: [],
		normalizedTitle: "alex chen",
		titleTokens: ["alex", "chen"],
		lookupKeys: ["alex chen"],
		tags: [],
	};
	const index = {
		getAll() {
			return [sourceRecord, alexRecord];
		},
	};
	const settings = {
		firstOccurrenceOnly: true,
		maxLinksPerNote: 12,
		excludedFolders: [],
		excludedFiles: [],
		enableAliasMatching: true,
		skipHeadings: true,
		seeAlsoHeading: "See also",
		seeAlsoCount: 5,
		semanticMode: false,
		semanticProviderId: "ollama",
		semanticTopK: 8,
		semanticSummaryLength: 280,
		semanticTransformersModel: "Xenova/all-MiniLM-L6-v2",
		semanticOllamaBaseUrl: "http://127.0.0.1:11434",
		semanticOllamaModel: "embeddinggemma",
		semanticProjectionMetric: "cosine",
		semanticExplorerLabelDistance: 620,
		semanticDisplayThreshold: 0.3,
		semanticAcceptanceThreshold: 0.6,
		autoRefreshEnabled: true,
		autoRefreshMinutes: 60,
	};

	const analysis = await analyzeNoteContent(
		sourceRecord,
		"Alex should review this after lunch.",
		index,
		settings,
		undefined,
	);
	const alexSuggestion = analysis.suggestions.find((suggestion) => suggestion.matchedText.toLowerCase() === "alex");

	assert.ok(alexSuggestion, "expected implicit first-name match for Alex Chen");
	assert.equal(alexSuggestion?.targetTitle, "Alex Chen");
	assert.equal(alexSuggestion?.matchType, "alias");
});

test("current-note analysis is robust to punctuation splits in person names", async () => {
	const harness = await createDevVaultHarness();
	const sourceRecord = {
		file: {
			path: "Scratch.md",
			fullPath: "Scratch.md",
			basename: "Scratch",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Scratch.md",
		linkTarget: "Scratch",
		title: "Scratch",
		aliases: [],
		normalizedTitle: "scratch",
		titleTokens: ["scratch"],
		lookupKeys: ["scratch"],
		tags: [],
	};
	const index = {
		getAll() {
			return [sourceRecord, ...harness.recordMap.values()];
		},
	};

	const nameAnalysis = await analyzeNoteContent(
		sourceRecord,
		"sam ri-vera should review this architecture note.",
		index,
		harness.settings,
		harness.semanticIndex,
	);
	const nameSuggestion = nameAnalysis.suggestions.find((suggestion) => suggestion.matchedText.toLowerCase() === "sam ri-vera");
	assert.ok(nameSuggestion, "expected punctuation-folded Sam Rivera match");
	assert.equal(nameSuggestion?.targetTitle, "Sam Rivera");
});

test("current-note analysis catches acronym and typo-heavy concept links in one note", async () => {
	const harness = await createDevVaultHarness();
	const sourceRecord = {
		file: {
			path: "Scratch.md",
			fullPath: "Scratch.md",
			basename: "Scratch",
			extension: "md",
			stat: { mtime: Date.now() },
		},
		path: "Scratch.md",
		linkTarget: "Scratch",
		title: "Scratch",
		aliases: [],
		normalizedTitle: "scratch",
		titleTokens: ["scratch"],
		lookupKeys: ["scratch"],
		tags: [],
	};
	const index = {
		getAll() {
			return [sourceRecord, ...harness.recordMap.values()];
		},
	};
	const analysis = await analyzeNoteContent(
		sourceRecord,
		"principle component analysis\nlesure systems",
		index,
		harness.settings,
		harness.semanticIndex,
	);
	const byMatch = new Map(analysis.suggestions.map((suggestion) => [suggestion.matchedText.toLowerCase(), suggestion]));

	assert.equal(byMatch.get("principle component analysis")?.targetTitle, "PCA");
	assert.equal(byMatch.get("lesure systems")?.targetTitle, "Hobby Systems");
});

test("meaning as coordinates keeps PCA and avoids low-signal semantic drift", async () => {
	const harness = await createDevVaultHarness();
	const analysis = await harness.analyzeNote("Semantic Playground/Meaning As Coordinates.md");
	const targets = new Set(analysis.suggestions.map((suggestion) => suggestion.targetTitle));
	const matches = new Set(analysis.suggestions.map((suggestion) => suggestion.matchedText));

	assert.ok(targets.has("PCA"), `expected PCA in Meaning As Coordinates, got ${[...targets].join(", ")}`);
	assert.ok(!targets.has("Session Recap"), "Meaning As Coordinates should not drift to Session Recap");
	assert.ok(
		![...matches].some((match) => /^one way to represent/i.test(match)),
		`low-signal lead-in should not survive, got ${[...matches].join(", ")}`,
	);
});

test("semantic suggestions do not overlap within a note", async () => {
	const harness = await createDevVaultHarness();
	const notes = [
		"Semantic Challenge Note.md",
		"Semantic Playground/_Semantic Benchmark Map.md",
		"Semantic Playground/Digital Garden Pages.md",
		"Semantic Playground/Tennis Semantic Probe.md",
		"Semantic Playground/Acronym And Name Probe.md",
	];

	for (const note of notes) {
		const analysis = await harness.analyzeNote(note);
		const semanticSuggestions = analysis.suggestions.filter((suggestion) => suggestion.matchType === "semantic");
		for (let index = 0; index < semanticSuggestions.length; index += 1) {
			const current = semanticSuggestions[index];
			for (let compareIndex = index + 1; compareIndex < semanticSuggestions.length; compareIndex += 1) {
				const other = semanticSuggestions[compareIndex];
				const overlaps = current.start < other.end && other.start < current.end;
				assert.equal(
					overlaps,
					false,
					`overlapping semantic suggestions in ${note}: "${current.matchedText}" and "${other.matchedText}"`,
				);
			}
		}
	}
});

test("benchmark and writing fixtures stay low-clutter", async () => {
	const harness = await createDevVaultHarness();
	const benchmark = await harness.analyzeNote("Semantic Playground/_Semantic Benchmark Map.md");
	const digitalGarden = await harness.analyzeNote("Semantic Playground/Digital Garden Pages.md");

	const benchmarkSemantic = benchmark.suggestions.filter((suggestion) => suggestion.matchType === "semantic");
	const digitalGardenTargets = new Set(digitalGarden.suggestions.map((suggestion) => suggestion.targetTitle));

	assert.ok(
		benchmarkSemantic.length <= 1,
		`expected at most one semantic suggestion for benchmark map, got ${benchmarkSemantic.length}`,
	);
	assert.ok(
		!digitalGardenTargets.has("Knowledge Graph"),
		"Digital Garden Pages should not drift to generic graph notes",
	);
	assert.ok(
		digitalGardenTargets.has("Evergreen Notes") || digitalGardenTargets.has("PKM"),
		"Digital Garden Pages should surface a durable-writing or PKM target",
	);
});

test("warm semantic analysis is faster than cold on the dev vault", async () => {
	const harness = await createDevVaultHarness();

	const wholeVaultColdStart = performance.now();
	await harness.analyzeWholeVault();
	const wholeVaultColdMs = performance.now() - wholeVaultColdStart;

	const wholeVaultWarmStart = performance.now();
	await harness.analyzeWholeVault();
	const wholeVaultWarmMs = performance.now() - wholeVaultWarmStart;

	console.log(`semantic whole-vault cold=${wholeVaultColdMs.toFixed(1)}ms warm=${wholeVaultWarmMs.toFixed(1)}ms`);
	assert.ok(
		wholeVaultWarmMs <= wholeVaultColdMs * 1.1,
		`expected warm whole-vault analysis to be faster or similar (cold=${wholeVaultColdMs.toFixed(1)}ms warm=${wholeVaultWarmMs.toFixed(1)}ms)`,
	);
});
