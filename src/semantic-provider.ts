import { requestUrl } from "obsidian";
import type { SemanticAutoLinkerSettings, SemanticProviderModel } from "./types";

const TRANSFORMERS_IMPORT_TIMEOUT_MS = 20_000;
const TRANSFORMERS_MODEL_LOAD_TIMEOUT_MS = 45_000;
const TRANSFORMERS_INFERENCE_TIMEOUT_MS = 30_000;

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

class LocalFallbackSemanticProvider implements SemanticProvider {
	readonly id = "local-fallback";
	readonly label = "Local fallback (offline)";

	getModelId(_settings: SemanticAutoLinkerSettings): string {
		return "local-fallback:hash-384:v1";
	}

	checkAvailability(_settings: SemanticAutoLinkerSettings): Promise<SemanticProviderAvailability> {
		return Promise.resolve({
			available: true,
			reason: null,
		});
	}

	listModels(_settings: SemanticAutoLinkerSettings): Promise<SemanticProviderModel[]> {
		return Promise.resolve([
			{ id: this.getModelId(_settings), label: "Local fallback embeddings (offline)" },
		]);
	}

	embed(text: string, _settings: SemanticAutoLinkerSettings): Promise<number[]> {
		return Promise.resolve(buildFallbackEmbedding(text));
	}

	embedBatch(texts: string[], _settings: SemanticAutoLinkerSettings): Promise<number[][]> {
		return Promise.resolve(texts.map(buildFallbackEmbedding));
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
	private inferenceQueue: Promise<void> = Promise.resolve();

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
		return await this.runQueued(async () => {
			const model = getTransformersModel(settings);
			const device = getTransformersDevice(settings);
			const extractor = await this.getExtractor(model, device);
			const output = await withTimeout(
				extractor(texts.length === 1 ? texts[0] ?? "" : texts, {
					pooling: "mean",
					normalize: true,
				}),
				TRANSFORMERS_INFERENCE_TIMEOUT_MS,
				"Local embedding inference timed out. Falling back to offline embeddings.",
			);
			return tensorOutputToVectors(output, texts.length);
		});
	}

	private getExtractor(model: string, configuredDevice: TransformersDevice): Promise<TransformersExtractor> {
		const cacheKey = `${model}::${configuredDevice}`;
		const existing = this.extractorByModel.get(cacheKey);
		if (existing) {
			return existing;
		}
		const next = loadTransformersExtractor(model, configuredDevice).catch((error) => {
			this.extractorByModel.delete(cacheKey);
			throw error;
		});
		this.extractorByModel.set(cacheKey, next);
		return next;
	}

	private async runQueued<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.inferenceQueue;
		let release: () => void = () => undefined;
		this.inferenceQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await task();
		} finally {
			release();
		}
	}
}

export class SemanticProviderRegistry {
	private providers: SemanticProvider[];

	constructor() {
		this.providers = [
			new DisabledSemanticProvider(),
			new TransformersSemanticProvider(),
			new LocalFallbackSemanticProvider(),
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
type TransformersDevice = SemanticAutoLinkerSettings["semanticTransformersDevice"];

async function loadTransformersExtractor(model: string, configuredDevice: TransformersDevice): Promise<TransformersExtractor> {
	const transformers = await withTimeout(
		import("@huggingface/transformers"),
		TRANSFORMERS_IMPORT_TIMEOUT_MS,
		"Local embedding runtime did not load in time. Falling back to offline embeddings.",
	);
	const preferredDevices = getPreferredTransformersDevices(configuredDevice);
	let fallbackError: unknown = null;
	for (const device of preferredDevices) {
		try {
			const extractor = await withTimeout(
				transformers.pipeline("feature-extraction", model, {
					quantized: true,
					device,
				} as object),
				TRANSFORMERS_MODEL_LOAD_TIMEOUT_MS,
				`Local embedding model "${model}" did not load in time on ${device}. Falling back to offline embeddings.`,
			);
			return extractor as TransformersExtractor;
		} catch (error) {
			fallbackError = error;
			if (configuredDevice !== "auto") {
				break;
			}
		}
	}
	if (fallbackError instanceof Error) {
		throw fallbackError;
	}
	throw new Error("Could not load the local embedding model.");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
		}
	});
}

function getPreferredTransformersDevices(configuredDevice: TransformersDevice): Array<"webgpu" | "cpu"> {
	if (configuredDevice === "webgpu") {
		return ["webgpu"];
	}
	if (configuredDevice === "cpu") {
		return ["cpu"];
	}
	return hasWebGpuSupport() ? ["webgpu", "cpu"] : ["cpu"];
}

function hasWebGpuSupport(): boolean {
	return typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu);
}

function getTransformersDevice(settings: SemanticAutoLinkerSettings): TransformersDevice {
	const device = settings.semanticTransformersDevice;
	return device === "webgpu" || device === "cpu" ? device : "auto";
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

function buildFallbackEmbedding(text: string): number[] {
	const dimensions = 384;
	const vector = new Array<number>(dimensions).fill(0);
	const tokens = tokenizeFallbackText(text);
	for (const token of tokens) {
		const tokenHash = hashText(token);
		const index = tokenHash % dimensions;
		const sign = tokenHash % 2 === 0 ? 1 : -1;
		const weight = 1 + Math.min(2, token.length / 8);
		vector[index] = (vector[index] ?? 0) + sign * weight;
		for (const gram of characterTrigrams(token)) {
			const gramHash = hashText(gram);
			const gramIndex = gramHash % dimensions;
			vector[gramIndex] = (vector[gramIndex] ?? 0) + (gramHash % 2 === 0 ? 0.28 : -0.28);
		}
	}
	return normalizeDenseVector(vector);
}

function tokenizeFallbackText(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.match(/[a-z0-9][a-z0-9#+-]{1,}/g) ?? [];
}

function characterTrigrams(token: string): string[] {
	if (token.length < 3) {
		return [token];
	}
	const padded = ` ${token} `;
	const grams: string[] = [];
	for (let index = 0; index <= padded.length - 3; index += 1) {
		grams.push(padded.slice(index, index + 3));
	}
	return grams;
}

function hashText(text: string): number {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function normalizeDenseVector(vector: number[]): number[] {
	let norm = 0;
	for (const value of vector) {
		norm += value * value;
	}
	if (norm === 0) {
		vector[0] = 1;
		return vector;
	}
	const scale = Math.sqrt(norm);
	return vector.map((value) => value / scale);
}
