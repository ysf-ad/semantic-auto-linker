import { requestUrl } from "obsidian";
import type { SemanticAutoLinkerSettings, SemanticProviderModel } from "./types";

export interface SemanticProviderAvailability {
	available: boolean;
	reason: string | null;
}

export interface SemanticProvider {
	id: string;
	label: string;
	getModelId(settings: SemanticAutoLinkerSettings): string;
	checkAvailability(settings: SemanticAutoLinkerSettings): Promise<SemanticProviderAvailability>;
	listModels?(settings: SemanticAutoLinkerSettings): Promise<SemanticProviderModel[]>;
	embed(text: string, settings: SemanticAutoLinkerSettings): Promise<number[]>;
	embedBatch?(texts: string[], settings: SemanticAutoLinkerSettings): Promise<number[][]>;
}

class DisabledSemanticProvider implements SemanticProvider {
	readonly id = "none";
	readonly label = "Disabled";

	getModelId(_settings: SemanticAutoLinkerSettings): string {
		return "none";
	}

	checkAvailability(_settings: SemanticAutoLinkerSettings): Promise<SemanticProviderAvailability> {
		return Promise.resolve({
			available: false,
			reason: "No semantic provider selected.",
		});
	}

	embed(_text: string, _settings: SemanticAutoLinkerSettings): Promise<number[]> {
		return Promise.reject(new Error("Semantic provider is disabled."));
	}
}

class OllamaSemanticProvider implements SemanticProvider {
	readonly id = "ollama";
	readonly label = "Ollama (local)";

	getModelId(settings: SemanticAutoLinkerSettings): string {
		const baseUrl = normalizeBaseUrl(settings.semanticOllamaBaseUrl);
		const model = settings.semanticOllamaModel.trim() || "unconfigured";
		return `ollama:${baseUrl}:${model}`;
	}

	async checkAvailability(settings: SemanticAutoLinkerSettings): Promise<SemanticProviderAvailability> {
		const baseUrl = normalizeBaseUrl(settings.semanticOllamaBaseUrl);
		const model = settings.semanticOllamaModel.trim();
		if (!baseUrl) {
			return {
				available: false,
				reason: "No Ollama base URL configured.",
			};
		}
		if (!model) {
			return {
				available: false,
				reason: "No Ollama model configured.",
			};
		}

		try {
			const models = await fetchOllamaModels(baseUrl);
			const hasModel = models.some((candidate) => matchesOllamaModel(candidate, model));
			return hasModel
				? { available: true, reason: null }
				: {
					available: false,
					reason: buildMissingModelReason(model, models),
				};
		} catch (error) {
			const reason = error instanceof Error ? error.message : "Unknown network error";
			return {
				available: false,
				reason: `Could not reach Ollama at ${baseUrl}: ${reason}`,
			};
		}
	}

	async listModels(settings: SemanticAutoLinkerSettings): Promise<SemanticProviderModel[]> {
		const baseUrl = normalizeBaseUrl(settings.semanticOllamaBaseUrl);
		if (!baseUrl) {
			return [];
		}
		const models = await fetchOllamaModels(baseUrl);
		const names = Array.from(
			new Set(
				models
					.map((candidate) => candidate.name ?? candidate.model ?? "")
					.filter(Boolean),
			),
		);
		const embeddable: SemanticProviderModel[] = [];
		for (const model of names) {
			if (await canEmbedWithOllama(baseUrl, model)) {
				embeddable.push({
					id: model,
					label: model,
				});
			}
		}
		return embeddable;
	}

	async embed(text: string, settings: SemanticAutoLinkerSettings): Promise<number[]> {
		const [vector] = await this.embedBatch([text], settings);
		if (!vector) {
			throw new Error("Ollama returned no embedding vector.");
		}
		return vector;
	}

	async embedBatch(texts: string[], settings: SemanticAutoLinkerSettings): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}
		const baseUrl = normalizeBaseUrl(settings.semanticOllamaBaseUrl);
		const model = settings.semanticOllamaModel.trim();
		if (!baseUrl || !model) {
			throw new Error("Ollama base URL and model must be configured before embedding.");
		}

		const payload = await requestJson<OllamaEmbedResponse>(`${baseUrl}/api/embed`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				input: texts,
				truncate: true,
			}),
		});
		if (!Array.isArray(payload.embeddings)) {
			throw new Error("Ollama embedding response did not include embeddings.");
		}
		return payload.embeddings.map((vector) => normalizeVector(vector));
	}
}

class TransformersSemanticProvider implements SemanticProvider {
	readonly id = "transformers";
	readonly label = "Local model (built-in)";
	private extractorByModel = new Map<string, Promise<TransformersExtractor>>();

	getModelId(settings: SemanticAutoLinkerSettings): string {
		return `transformers:${getTransformersModel(settings)}`;
	}

	checkAvailability(settings: SemanticAutoLinkerSettings): Promise<SemanticProviderAvailability> {
		const model = getTransformersModel(settings);
		return Promise.resolve({
			available: Boolean(model),
			reason: model ? null : "No local embedding model configured.",
		});
	}

	listModels(_settings: SemanticAutoLinkerSettings): Promise<SemanticProviderModel[]> {
		return Promise.resolve([
			{ id: "Xenova/all-MiniLM-L6-v2", label: "Xenova/all-MiniLM-L6-v2 (fast default)" },
			{ id: "Xenova/bge-small-en-v1.5", label: "Xenova/bge-small-en-v1.5 (higher quality)" },
			{ id: "onnx-community/embeddinggemma-300m-ONNX", label: "EmbeddingGemma 300M (larger)" },
		]);
	}

	async embed(text: string, settings: SemanticAutoLinkerSettings): Promise<number[]> {
		const [vector] = await this.embedBatch([text], settings);
		if (!vector) {
			throw new Error("Local embedding model returned no vector.");
		}
		return vector;
	}

	async embedBatch(texts: string[], settings: SemanticAutoLinkerSettings): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}
		const model = getTransformersModel(settings);
		const extractor = await this.getExtractor(model);
		const output = await extractor(texts.length === 1 ? texts[0] ?? "" : texts, {
			pooling: "mean",
			normalize: true,
		});
		return tensorOutputToVectors(output, texts.length);
	}

	private getExtractor(model: string): Promise<TransformersExtractor> {
		const existing = this.extractorByModel.get(model);
		if (existing) {
			return existing;
		}
		const next = loadTransformersExtractor(model);
		this.extractorByModel.set(model, next);
		return next;
	}
}

export class SemanticProviderRegistry {
	private providers: SemanticProvider[];

	constructor() {
		this.providers = [
			new DisabledSemanticProvider(),
			new TransformersSemanticProvider(),
			new OllamaSemanticProvider(),
		];
	}

	getAll(): SemanticProvider[] {
		return [...this.providers];
	}

	getById(id: string): SemanticProvider {
		const provider = this.providers.find((candidate) => candidate.id === id);
		return provider ?? new DisabledSemanticProvider();
	}
}

interface OllamaEmbedResponse {
	embeddings?: unknown[];
}

type TransformersExtractor = (input: string | string[], options: { pooling: string; normalize: boolean }) => Promise<unknown>;

async function loadTransformersExtractor(model: string): Promise<TransformersExtractor> {
	const transformers = await import("@huggingface/transformers");
	const extractor = await transformers.pipeline("feature-extraction", model, {
		quantized: true,
	} as object);
	return extractor as TransformersExtractor;
}

function getTransformersModel(settings: SemanticAutoLinkerSettings): string {
	return (settings.semanticTransformersModel ?? "Xenova/all-MiniLM-L6-v2").trim() || "Xenova/all-MiniLM-L6-v2";
}

function tensorOutputToVectors(output: unknown, expectedCount: number): number[][] {
	const values = tensorToList(output);
	if (expectedCount === 1 && isNumberArray(values)) {
		return [normalizeVector(values)];
	}
	if (Array.isArray(values) && values.every(isNumberArray)) {
		return values.map((vector) => normalizeVector(vector));
	}
	if (Array.isArray(values) && values.length === 1 && Array.isArray(values[0]) && values[0].every(isNumberArray)) {
		return (values[0] as unknown[]).map((vector) => normalizeVector(vector));
	}
	throw new Error("Local embedding model returned an unexpected vector shape.");
}

function tensorToList(output: unknown): unknown {
	if (output && typeof output === "object" && "tolist" in output && typeof output.tolist === "function") {
		return (output as { tolist: () => unknown }).tolist();
	}
	return output;
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

function matchesOllamaModel(candidate: { name?: string; model?: string }, requested: string): boolean {
	return [candidate.name, candidate.model]
		.filter((value): value is string => Boolean(value))
		.some((value) => value === requested || value === `${requested}:latest` || stripOllamaTag(value) === requested);
}

function stripOllamaTag(model: string): string {
	const separator = model.indexOf(":");
	return separator === -1 ? model : model.slice(0, separator);
}

function buildMissingModelReason(requested: string, models: Array<{ name?: string; model?: string }>): string {
	const availableModels = models
		.map((candidate) => candidate.name ?? candidate.model ?? "")
		.filter(Boolean)
		.slice(0, 5);
	if (availableModels.length === 0) {
		return `Ollama model "${requested}" was not found. No local Ollama models were listed.`;
	}
	return `Ollama model "${requested}" was not found. Available models: ${availableModels.join(", ")}.`;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
	const response = await requestUrl({
		url,
		method: init.method,
		headers: init.headers as Record<string, string> | undefined,
		body: typeof init.body === "string" ? init.body : undefined,
		throw: false,
		contentType: "application/json",
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Request failed with status ${response.status}`);
	}
	return response.json as T;
}

async function fetchOllamaModels(baseUrl: string): Promise<Array<{ name?: string; model?: string }>> {
	const response = await requestUrl({
		url: `${baseUrl}/api/tags`,
		method: "GET",
		throw: false,
		contentType: "application/json",
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Ollama returned ${response.status} for /api/tags.`);
	}
	const payload = response.json as { models?: Array<{ name?: string; model?: string }> };
	return Array.isArray(payload.models) ? payload.models : [];
}

async function canEmbedWithOllama(baseUrl: string, model: string): Promise<boolean> {
	try {
		const payload = await requestJson<OllamaEmbedResponse>(`${baseUrl}/api/embed`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				input: "semantic-auto-linker model probe",
				truncate: true,
			}),
		});
		return Array.isArray(payload.embeddings) && payload.embeddings.length > 0;
	} catch {
		return false;
	}
}

function normalizeVector(vector: unknown): number[] {
	if (!Array.isArray(vector)) {
		throw new Error("Embedding vector is not an array.");
	}
	const normalized = vector.map((value) => {
		if (typeof value !== "number" || Number.isNaN(value)) {
			throw new Error("Embedding vector contains a non-numeric value.");
		}
		return value;
	});
	if (normalized.length === 0) {
		throw new Error("Embedding vector is empty.");
	}
	return normalized;
}
