import { Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, SemanticAutoLinkerSettingTab } from "./settings";
import type {
	AnalysisResult,
	LinkSuggestion,
	NoteRecord,
	PersistedVaultAnalysisSnapshot,
	PluginStorageData,
	Range,
	RelatedNoteSuggestion,
	SemanticAutoLinkerSettings,
	SemanticBuildProgress,
	SemanticCacheEntry,
	SemanticIndexStatus,
	SemanticProviderModel,
	VaultAnalysisJobState,
	VaultAnalysisRunProgress,
	VaultAnalysisResult,
} from "./types";
import { analyzeNoteContent, applySuggestionsToSource } from "./matcher";
import { buildSeeAlsoSuggestions, upsertSeeAlsoSection } from "./footer";
import { LinkReviewModal, RelatedNotesModal, ReviewInsertionMode, VaultLinkModeModal, VaultReviewModal, type VaultLinkModeChoice } from "./review-modal";
import { VaultIndex } from "./vault-index";
import { analyzeEntireVault, recomputeVaultAnalysis } from "./vault-analysis";
import { SEMANTIC_AUTO_LINKER_VIEW_TYPE, SemanticAutoLinkerView } from "./view";
import { SemanticProviderRegistry } from "./semantic-provider";
import { SemanticIndex } from "./semantic-index";
import { SemanticBuildProgressModal } from "./semantic-progress-modal";
import { EmbeddingExplorerModal } from "./embedding-explorer-modal";
import { createInitialVaultAnalysisJobState, hydrateVaultAnalysis, serializeVaultAnalysis } from "./vault-analysis-state";

export default class SemanticAutoLinkerPlugin extends Plugin {
	settings: SemanticAutoLinkerSettings;
	private index!: VaultIndex;
	private semanticIndex!: SemanticIndex;
	private semanticProviders = new SemanticProviderRegistry();
	private semanticCache: Record<string, SemanticCacheEntry> = {};
	private indexReady = false;
	private lastVaultAnalysis: VaultAnalysisResult | null = null;
	private persistedVaultAnalysisSnapshot: PersistedVaultAnalysisSnapshot | null = null;
	private vaultAnalysisJobState: VaultAnalysisJobState = createInitialVaultAnalysisJobState();
	private vaultRevision = 0;
	private analysisRevision = -1;
	private maintenanceRunning = false;
	private pendingSemanticPaths = new Set<string>();
	private pendingIndexPaths = new Set<string>();
	private pendingVaultAnalysisPaths = new Set<string>();
	private lastAutoMaintenanceAt = Date.now();
	private viewRefreshHandle: number | null = null;
	private pluginDataSaveHandle: number | null = null;
	private maintenanceTimeoutHandle: number | null = null;
	private cursorPollTimeoutHandle: number | null = null;
	private activeVaultReviewModal: VaultReviewModal | null = null;
	private vaultAnalysisRunPromise: Promise<void> | null = null;
	private semanticRebuildPromise: Promise<void> | null = null;
	private vaultAnalysisRefreshHandle: number | null = null;
	private liveSemanticRefreshHandle: number | null = null;
	private liveSemanticRefreshKey: string | null = null;
	private liveSemanticRefreshRunning = false;
	private liveSemanticDirtyPath: string | null = null;
	private lastSidebarCursorKey: string | null = null;
	private lastKnownEditorPath: string | null = null;

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.index = new VaultIndex(this.app, this.settings);
		this.semanticIndex = new SemanticIndex(this.app, this.index, this.semanticProviders, this.settings, this.semanticCache);

		this.registerView(
			SEMANTIC_AUTO_LINKER_VIEW_TYPE,
			(leaf) => new SemanticAutoLinkerView(leaf, this),
		);

		this.addRibbonIcon("git-branch", "Semantic auto-linker", () => {
			void this.activateView();
		});

		this.addSettingTab(new SemanticAutoLinkerSettingTab(this.app, this));
		this.addCommands();
		this.registerVaultEvents();
		this.registerWorkspaceEvents();
		this.startMaintenanceLoop();
		this.startCursorPollLoop();

		this.app.workspace.onLayoutReady(async () => {
			await this.rebuildIndex("Initial note index built");
			this.restorePersistedVaultAnalysis();
		});
	}

	onunload(): void {
		this.indexReady = false;
	}

	async loadPluginData(): Promise<void> {
		const loadedData: unknown = await this.loadData();
		const raw = isPluginStorageDataShape(loadedData) ? loadedData : null;
		const settingsSource = raw && "settings" in raw ? raw.settings ?? {} : raw ?? {};
		const semanticCache = raw && "semanticCache" in raw ? raw.semanticCache ?? {} : {};
		const vaultAnalysisSnapshot = raw && "vaultAnalysisSnapshot" in raw ? raw.vaultAnalysisSnapshot ?? null : null;
		const vaultAnalysisJobState = raw && "vaultAnalysisJobState" in raw ? raw.vaultAnalysisJobState ?? null : null;
		const { settings, migrated } = migrateLoadedSettings(settingsSource);
		this.settings = settings;
		this.semanticCache = semanticCache;
		this.persistedVaultAnalysisSnapshot = vaultAnalysisSnapshot;
		this.vaultAnalysisJobState = vaultAnalysisJobState
			? { ...createInitialVaultAnalysisJobState(), ...vaultAnalysisJobState }
			: createInitialVaultAnalysisJobState();
		if (migrated) {
			await this.savePluginData();
		}
	}

	async saveSettings(): Promise<void> {
		this.index.updateSettings(this.settings);
		this.semanticIndex.updateSettings(this.settings);
		await this.savePluginData();
		this.refreshView();
	}

	async savePluginData(): Promise<void> {
		const payload: PluginStorageData = {
			settings: this.settings,
			semanticCache: this.semanticCache,
			vaultAnalysisSnapshot: this.persistedVaultAnalysisSnapshot,
			vaultAnalysisJobState: this.vaultAnalysisJobState,
		};
		await this.saveData(payload);
	}

	async rebuildIndex(successMessage?: string): Promise<void> {
		this.index.updateSettings(this.settings);
		await this.index.rebuild();
		await this.semanticIndex.hydrateFromCache();
		this.indexReady = true;
		this.bumpVaultRevision();
		if (successMessage) {
			new Notice(`${successMessage} (${this.index.size} notes)`);
		}
		this.refreshView();
	}

	async updateExcludedTargetFiles(paths: string[]): Promise<void> {
		const nextPaths = normalizeVaultPathList(paths);
		if (sameStringList(this.settings.excludedTargetFiles ?? [], nextPaths)) {
			this.pruneExcludedTargetSuggestions();
			this.scheduleViewRefresh();
			return;
		}
		this.settings.excludedTargetFiles = nextPaths;
		await this.saveSettings();
		this.pruneExcludedTargetSuggestions();
		this.scheduleViewRefresh();
	}

	async excludeTargetFromMatching(targetPath: string, targetTitle?: string): Promise<void> {
		const normalizedPath = normalizeVaultPath(targetPath);
		if (!normalizedPath) {
			return;
		}
		const currentPaths = this.settings.excludedTargetFiles ?? [];
		const previousCount = currentPaths.length;
		await this.updateExcludedTargetFiles([...currentPaths, normalizedPath]);
		const label = targetTitle?.trim() || normalizedPath.replace(/\.md$/i, "");
		const alreadyExcluded = previousCount === this.settings.excludedTargetFiles.length;
		new Notice(alreadyExcluded
			? `${label} is already excluded from matching.`
			: `Excluded ${label} from future match suggestions.`);
	}

	getIndexSize(): number {
		return this.index.size;
	}

	getLastVaultAnalysis(): VaultAnalysisResult | null {
		return this.lastVaultAnalysis;
	}

	getVaultAnalysisJobState(): VaultAnalysisJobState {
		return {
			...this.vaultAnalysisJobState,
			stalePaths: [...this.vaultAnalysisJobState.stalePaths],
		};
	}

	hasPendingVaultAnalysisUpdates(): boolean {
		return this.pendingVaultAnalysisPaths.size > 0;
	}

	getSemanticStatus(): SemanticIndexStatus {
		return this.semanticIndex.getStatus();
	}

	getActiveSemanticIndicator(): { state: "clean" | "dirty" | "refreshing"; fileTitle: string | null } {
		const file = this.getActiveFile();
		if (!file || !this.settings.semanticMode) {
			return {
				state: "clean",
				fileTitle: null,
			};
		}
		if (this.liveSemanticRefreshRunning && this.liveSemanticDirtyPath === file.path) {
			return {
				state: "refreshing",
				fileTitle: file.basename,
			};
		}
		if (this.liveSemanticDirtyPath === file.path) {
			return {
				state: "dirty",
				fileTitle: file.basename,
			};
		}
		return {
			state: "clean",
			fileTitle: file.basename,
		};
	}

	getSemanticProviders(): Array<{ id: string; label: string }> {
		return this.semanticProviders.getAll().map((provider) => ({
			id: provider.id,
			label: provider.label,
		}));
	}

	async getSemanticProviderModels(providerId = this.settings.semanticProviderId): Promise<SemanticProviderModel[]> {
		const provider = this.semanticProviders.getById(providerId);
		if (!provider.listModels) {
			return [];
		}
		return await provider.listModels(this.settings);
	}

	async runCurrentNoteAnalysisFromView(): Promise<void> {
		const file = this.getActiveFile();
		if (!file) {
			new Notice("Open a Markdown note first.");
			return;
		}
		await this.openReviewForFile(file);
	}

	async runVaultAnalysisFromView(): Promise<void> {
		await this.openVaultReview({ forceRefresh: true });
	}

	async showRelatedNotesFromView(): Promise<void> {
		const file = this.getActiveFile();
		if (!file) {
			new Notice("Open a Markdown note first.");
			return;
		}
		await this.showRelatedNotes(file);
	}

	async getSidebarAutoLinkSuggestions(limit = 30): Promise<{ noteTitle: string; suggestions: LinkSuggestion[] } | null> {
		const file = this.getActiveFile();
		if (!file) {
			return null;
		}
		await this.ensureIndex();
		const record = this.requireRecord(file);
		const targetPath = this.lastKnownEditorPath ?? file.path;
		const view = this.findBestMarkdownView(targetPath);
		const source = view?.file?.path === file.path ? view.editor.getValue() : await this.app.vault.read(file);
		const cursorOffset = view?.file?.path === file.path
			? view.editor.posToOffset(view.editor.getCursor())
			: null;
		const analysis = await analyzeNoteContent(record, source, this.index, this.settings, this.semanticIndex);
		const suggestions = [...analysis.suggestions]
			.sort((left, right) =>
				cursorSuggestionPriority(left, cursorOffset) - cursorSuggestionPriority(right, cursorOffset)
				|| sidebarSuggestionPriority(right) - sidebarSuggestionPriority(left)
				|| Number(right.accepted) - Number(left.accepted)
				|| right.confidence - left.confidence
				|| left.start - right.start,
			)
			.slice(0, limit);
		return {
			noteTitle: file.basename,
			suggestions,
		};
	}

	async applySidebarSuggestion(suggestion: LinkSuggestion): Promise<void> {
		const sourceAbstract = suggestion.sourcePath
			? this.app.vault.getAbstractFileByPath(suggestion.sourcePath)
			: this.getActiveFile();
		const file = sourceAbstract instanceof TFile ? sourceAbstract : null;
		if (!file) {
			new Notice("Open the source note to apply this suggestion.");
			return;
		}
		const view = this.findBestMarkdownView(file.path);
		const editor = view?.editor;
		const source = editor ? editor.getValue() : await this.app.vault.read(file);
		const directSpanStillValid = source.slice(suggestion.start, suggestion.end) === suggestion.matchedText;
		if (directSpanStillValid) {
			const nextSource = applySuggestionsToSource(source, [{ ...suggestion, accepted: true }]);
			if (editor) {
				editor.setValue(nextSource);
			} else {
				await this.app.vault.modify(file, nextSource);
			}
			this.scheduleViewRefresh();
			return;
		}

		await this.ensureIndex();
		const record = this.requireRecord(file);
		const analysis = await analyzeNoteContent(record, source, this.index, this.settings, this.semanticIndex);
		const freshSuggestion = analysis.suggestions.find((candidate) =>
			candidate.targetPath === suggestion.targetPath
			&& candidate.matchedText === suggestion.matchedText
			&& Math.abs(candidate.start - suggestion.start) <= 12,
		) ?? analysis.suggestions.find((candidate) =>
			candidate.targetPath === suggestion.targetPath
			&& candidate.matchedText === suggestion.matchedText,
		);
		if (!freshSuggestion) {
			new Notice("That sidebar suggestion is no longer valid at the current cursor state.");
			this.scheduleViewRefresh();
			return;
		}
		const nextSource = applySuggestionsToSource(source, [{ ...freshSuggestion, accepted: true }]);
		if (editor) {
			editor.setValue(nextSource);
		} else {
			await this.app.vault.modify(file, nextSource);
		}
		this.scheduleViewRefresh();
	}

	async showEmbeddingExplorerFromView(): Promise<void> {
		await this.ensureIndex();
		new EmbeddingExplorerModal(this.app, this, this.semanticIndex).open();
	}

	async rebuildSemanticIndexFromView(): Promise<void> {
		if (!this.settings.semanticMode) {
			this.settings.semanticMode = true;
			await this.saveSettings();
		}
		await this.rebuildSemanticIndex();
	}

	private addCommands(): void {
		this.addCommand({
			id: "open-control-panel",
			name: "Open control panel",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "analyze-current-note",
			name: "Analyze current note for safe links",
			checkCallback: (checking) => this.withActiveMarkdownFile(checking, async (file) => {
				await this.openReviewForFile(file);
			}),
		});

		this.addCommand({
			id: "auto-link-selection",
			name: "Auto-link current selection",
			editorCheckCallback: (checking, editor) => {
				if (!editor.getSelection()) {
					return false;
				}
				if (!checking) {
					void this.openReviewForSelection(editor);
				}
				return true;
			},
		});

		this.addCommand({
			id: "analyze-whole-vault",
			name: "Analyze whole vault for safe links",
			callback: () => {
				void this.openVaultReview({ forceRefresh: true });
			},
		});

		this.addCommand({
			id: "show-embedding-explorer",
			name: "Show embedding explorer",
			callback: () => {
				void this.showEmbeddingExplorerFromView();
			},
		});

		this.addCommand({
			id: "rebuild-semantic-index",
			name: "Build or rebuild semantic index",
			callback: () => {
				void this.rebuildSemanticIndex();
			},
		});

		this.addCommand({
			id: "rebuild-note-index",
			name: "Build or rebuild note index",
			callback: () => {
				void this.rebuildIndex("Note index rebuilt");
			},
		});

		this.addCommand({
			id: "show-related-notes",
			name: "Show related notes",
			checkCallback: (checking) => this.withActiveMarkdownFile(checking, async (file) => {
				await this.showRelatedNotes(file);
			}),
		});
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.handleVaultMutation(async () => {
					await this.index.refreshFile(file);
					this.semanticIndex.invalidateFile(file.path);
					this.pendingIndexPaths.add(file.path);
					this.pendingSemanticPaths.add(file.path);
					this.markVaultAnalysisDirty([file.path]);
				});
			}
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.handleVaultMutation(async () => {
					await this.index.refreshFile(file);
					this.semanticIndex.invalidateFile(file.path);
					this.pendingIndexPaths.add(file.path);
					this.pendingSemanticPaths.add(file.path);
					this.markVaultAnalysisDirty([file.path]);
				});
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.handleVaultMutation(async () => {
					this.index.removeFile(oldPath);
					this.semanticIndex.removeFile(oldPath);
					await this.index.refreshFile(file);
					this.semanticIndex.invalidateFile(file.path);
					this.pendingIndexPaths.add(oldPath);
					this.pendingIndexPaths.add(file.path);
					this.pendingSemanticPaths.add(oldPath);
					this.pendingSemanticPaths.add(file.path);
					this.markVaultAnalysisDirty([oldPath, file.path]);
				});
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile) {
				void this.handleVaultMutation(() => {
					this.index.removeFile(file.path);
					this.semanticIndex.removeFile(file.path);
					this.pendingIndexPaths.add(file.path);
					this.pendingSemanticPaths.add(file.path);
					this.markVaultAnalysisDirty([file.path]);
					return Promise.resolve();
				});
			}
		}));
	}

	private registerWorkspaceEvents(): void {
		this.registerEvent(this.app.workspace.on("file-open", () => {
			this.liveSemanticDirtyPath = null;
			this.lastSidebarCursorKey = null;
			this.scheduleViewRefresh();
		}));
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			const view = leaf?.view;
			if (view instanceof MarkdownView && view.file) {
				this.lastKnownEditorPath = view.file.path;
			}
			this.lastSidebarCursorKey = null;
			this.scheduleViewRefresh();
		}));
		this.registerEvent(this.app.workspace.on("editor-change", (editor, view) => {
			if (view instanceof MarkdownView && view.file) {
				this.lastKnownEditorPath = view.file.path;
				this.liveSemanticDirtyPath = view.file.path;
			}
			this.scheduleViewRefresh(true);
			if (!(view instanceof MarkdownView) || !view.file) {
				return;
			}
			this.scheduleLiveSemanticRefresh(view.file, editor.getValue());
		}));
	}

	private async ensureIndex(): Promise<void> {
		if (!this.indexReady) {
			await this.rebuildIndex();
		}
	}

	private async activateView(): Promise<void> {
		for (const existingLeaf of this.app.workspace.getLeavesOfType(SEMANTIC_AUTO_LINKER_VIEW_TYPE)) {
			existingLeaf.detach();
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			return;
		}
		await leaf.setViewState({ type: SEMANTIC_AUTO_LINKER_VIEW_TYPE, active: true });
		this.app.workspace.rightSplit.expand();
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private startMaintenanceLoop(): void {
		const tick = () => {
			this.maintenanceTimeoutHandle = window.setTimeout(() => {
				void this.maybeRunAutoMaintenance();
				tick();
			}, 60_000);
		};
		tick();
		this.register(() => {
			if (this.maintenanceTimeoutHandle) {
				window.clearTimeout(this.maintenanceTimeoutHandle);
				this.maintenanceTimeoutHandle = null;
			}
		});
	}

	private startCursorPollLoop(): void {
		const tick = () => {
			this.cursorPollTimeoutHandle = window.setTimeout(() => {
				this.maybeRefreshForCursorMovement();
				tick();
			}, 250);
		};
		tick();
		this.register(() => {
			if (this.cursorPollTimeoutHandle) {
				window.clearTimeout(this.cursorPollTimeoutHandle);
				this.cursorPollTimeoutHandle = null;
			}
		});
	}

	private refreshView(): void {
		this.app.workspace.getLeavesOfType(SEMANTIC_AUTO_LINKER_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof SemanticAutoLinkerView) {
				void view.render();
			}
		});
	}

	private refreshLiveView(): void {
		this.app.workspace.getLeavesOfType(SEMANTIC_AUTO_LINKER_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof SemanticAutoLinkerView) {
				void view.refreshLive();
			}
		});
	}

	private maybeRefreshForCursorMovement(): void {
		if (this.app.workspace.getLeavesOfType(SEMANTIC_AUTO_LINKER_VIEW_TYPE).length === 0) {
			this.lastSidebarCursorKey = null;
			return;
		}

		const targetPath = this.lastKnownEditorPath ?? undefined;
		const view = this.findBestMarkdownView(targetPath);
		const file = view?.file;
		if (!view || !file) {
			this.lastSidebarCursorKey = null;
			return;
		}

		const cursorOffset = view.editor.posToOffset(view.editor.getCursor());
		const nextKey = `${file.path}:${cursorOffset}`;
		if (nextKey === this.lastSidebarCursorKey) {
			return;
		}
		this.lastSidebarCursorKey = nextKey;
		this.refreshLiveView();
	}

	private async openReviewForFile(file: TFile): Promise<void> {
		await this.ensureIndex();
		const source = await this.app.vault.read(file);
		const record = this.requireRecord(file);
		const analysis = await analyzeNoteContent(record, source, this.index, this.settings, this.semanticIndex);

		new LinkReviewModal(this.app, analysis, this.settings, async ({ suggestions, mode, useDisplayTitle }) => {
			await this.applyAnalysis(analysis, suggestions, undefined, mode, useDisplayTitle);
		}, async (targetPath, targetTitle) => {
			await this.excludeTargetFromMatching(targetPath, targetTitle);
		}, this.index.getAll()).open();
	}

	private async openReviewForSelection(editor: Editor): Promise<void> {
		const file = this.getActiveFile();
		if (!file) {
			return;
		}

		await this.ensureIndex();
		const source = editor.getValue();
		const selectionText = editor.getSelection();
		const selection = getSelectionOffsets(editor, source);
		if (!selection || !selectionText.trim()) {
			new Notice("Select some text first.");
			return;
		}

		const record = this.requireRecord(file);
		const analysis = await analyzeNoteContent(record, source, this.index, this.settings, this.semanticIndex, selection);

		new LinkReviewModal(this.app, analysis, this.settings, async ({ suggestions, mode, useDisplayTitle }) => {
			await this.applyAnalysis(analysis, suggestions, editor, mode, useDisplayTitle);
		}, async (targetPath, targetTitle) => {
			await this.excludeTargetFromMatching(targetPath, targetTitle);
		}, this.index.getAll()).open();
	}

	private async openVaultReview(options: { forceRefresh?: boolean } = {}): Promise<void> {
		await this.ensureIndex();
		const linkMode = options.forceRefresh ? await this.promptVaultLinkMode() : null;
		if (options.forceRefresh && !linkMode) {
			return;
		}
		if (this.activeVaultReviewModal) {
			this.activeVaultReviewModal.close();
		}
		const showExistingAnalysis = !options.forceRefresh && !this.vaultAnalysisRunPromise;
		const modal = new VaultReviewModal(
			this.app,
			showExistingAnalysis ? this.lastVaultAnalysis : null,
			this.settings,
			async (acceptedAnalysis, mode, useDisplayTitle) => {
				await this.applyVaultAnalysis(acceptedAnalysis, mode, useDisplayTitle);
			},
			() => {
				if (this.lastVaultAnalysis) {
					void this.persistCurrentVaultAnalysis();
					this.recomputeVaultAnalysisPreview(this.lastVaultAnalysis);
				}
			},
			() => {
				if (this.activeVaultReviewModal === modal) {
					this.activeVaultReviewModal = null;
				}
			},
			async (targetPath, targetTitle) => {
				await this.excludeTargetFromMatching(targetPath, targetTitle);
			},
			this.index.getAll(),
		);
		this.activeVaultReviewModal = modal;
		if (options.forceRefresh) {
			this.updateVaultAnalysisJobState({
				status: "running",
				mode: "full",
				current: 0,
				total: Math.max(1, this.index.getAll().length * 2),
				message: "Starting whole-vault analysis...",
				startedAt: Date.now(),
				error: null,
			});
		}
		modal.open();
		if (options.forceRefresh) {
			modal.updateProgress(this.getVaultAnalysisJobState());
		} else if (this.lastVaultAnalysis && (this.pendingVaultAnalysisPaths.size > 0 || this.analysisRevision !== this.vaultRevision)) {
			this.updateVaultAnalysisJobState({
				status: "running",
				mode: "full",
				current: 0,
				total: Math.max(1, this.index.getAll().length * 2),
				message: "Refreshing whole-vault analysis...",
				startedAt: Date.now(),
				error: null,
			});
		} else {
			modal.updateProgress(this.getVaultAnalysisJobState());
		}
		void this.ensureVaultAnalysisAvailable(options.forceRefresh ?? false, linkMode ?? undefined);
	}

	private async promptVaultLinkMode(): Promise<VaultLinkModeChoice | null> {
		const defaultChoice: VaultLinkModeChoice = {
			enableExactMatching: this.settings.enableExactMatching,
			enableSemanticSuggestions: this.settings.enableSemanticSuggestions,
		};
		if (!defaultChoice.enableExactMatching && !defaultChoice.enableSemanticSuggestions) {
			defaultChoice.enableExactMatching = true;
			defaultChoice.enableSemanticSuggestions = true;
		}
		const warning = this.getVaultLinkModeWarning(defaultChoice);
		return await new Promise((resolve) => {
			new VaultLinkModeModal(this.app, defaultChoice, warning, resolve, async () => {
				await this.rebuildSemanticIndexFromView();
			}).open();
		});
	}

	private getVaultLinkModeWarning(choice: VaultLinkModeChoice): string | null {
		if (!choice.enableSemanticSuggestions) {
			return null;
		}
		const status = this.getSemanticStatus();
		if (!this.settings.semanticMode) {
			return "AI matches need semantic mode. Start with exact matches only, or enable semantic mode and build embeddings first.";
		}
		if (status.cachedCount === 0) {
			return choice.enableExactMatching
				? "AI matches need embeddings. You can still start, but the review will only include exact matches until embeddings are built."
				: "AI matches need embeddings. Build embeddings first, or turn on exact matches for this run.";
		}
		if (status.pendingCount > 0) {
			return `${status.pendingCount} note${status.pendingCount === 1 ? "" : "s"} still need embeddings. AI matches may be incomplete.`;
		}
		return null;
	}

	private recomputeVaultAnalysisPreview(analysis: VaultAnalysisResult): void {
		removeSuggestionsForTargets(analysis, new Set(this.settings.excludedTargetFiles ?? []));
		recomputeVaultAnalysis(analysis, this.index.getAll());
		this.lastVaultAnalysis = analysis;
		this.analysisRevision = this.vaultRevision;
		this.persistedVaultAnalysisSnapshot = serializeVaultAnalysis(analysis, this.analysisRevision);
		this.schedulePluginDataSave();
		this.refreshView();
		this.activeVaultReviewModal?.updateAnalysis(analysis);
	}

	private pruneExcludedTargetSuggestions(): void {
		if (!this.lastVaultAnalysis) {
			return;
		}
		const removedCount = removeSuggestionsForTargets(this.lastVaultAnalysis, new Set(this.settings.excludedTargetFiles ?? []));
		if (removedCount === 0) {
			return;
		}
		this.recomputeVaultAnalysisPreview(this.lastVaultAnalysis);
	}

	private async applyVaultAnalysis(analysis: VaultAnalysisResult, mode: ReviewInsertionMode, useDisplayTitle: boolean): Promise<void> {
		let filesChanged = 0;
		let suggestionsApplied = 0;

		for (const result of analysis.results) {
			const acceptedSuggestions = result.suggestions.filter((suggestion) => suggestion.accepted);
			if (acceptedSuggestions.length === 0) {
				continue;
			}
			const nextSource = mode === "footer"
				? upsertSeeAlsoSection(result.source, buildFooterSuggestionsFromAccepted(acceptedSuggestions), this.settings, useDisplayTitle)
				: applySuggestionsToSource(result.source, acceptedSuggestions);
			await this.app.vault.modify(result.file, nextSource);
			filesChanged += 1;
			suggestionsApplied += acceptedSuggestions.length;
		}

		new Notice(mode === "footer"
			? `Updated footer links across ${filesChanged} notes from ${suggestionsApplied} accepted suggestion${suggestionsApplied === 1 ? "" : "s"}.`
			: `Applied ${suggestionsApplied} links across ${filesChanged} notes.`);
		this.lastVaultAnalysis = null;
		this.persistedVaultAnalysisSnapshot = null;
		this.analysisRevision = -1;
		this.pendingVaultAnalysisPaths.clear();
		this.updateVaultAnalysisJobState({
			status: "idle",
			mode: "full",
			current: 0,
			total: 0,
			message: "Whole-vault analysis has been applied.",
			completedAt: Date.now(),
			error: null,
			stalePaths: [],
		});
		await this.rebuildIndex();
	}

	private async applyAnalysis(
		analysis: AnalysisResult,
		acceptedSuggestions = analysis.suggestions,
		editor?: Editor,
		mode: ReviewInsertionMode = "inline",
		useDisplayTitle = true,
	): Promise<void> {
		if (acceptedSuggestions.length === 0) {
			new Notice("No accepted suggestions to apply.");
			return;
		}

		const nextSource = mode === "footer"
			? upsertSeeAlsoSection(analysis.source, buildFooterSuggestionsFromAccepted(acceptedSuggestions), this.settings, useDisplayTitle)
			: applySuggestionsToSource(analysis.source, acceptedSuggestions);
		if (editor && this.getActiveFile()?.path === analysis.file.path) {
			editor.setValue(nextSource);
		} else {
			await this.app.vault.modify(analysis.file, nextSource);
		}

		new Notice(mode === "footer"
			? `Updated footer links from ${acceptedSuggestions.length} accepted suggestion${acceptedSuggestions.length === 1 ? "" : "s"}.`
			: `Applied ${acceptedSuggestions.length} link suggestion${acceptedSuggestions.length === 1 ? "" : "s"}.`);
		await this.rebuildIndex();
	}

	private async showRelatedNotes(file: TFile): Promise<void> {
		await this.ensureIndex();
		const record = this.requireRecord(file);
		const source = await this.app.vault.read(file);
		const suggestions = await this.buildRelatedSuggestions(record, extractLinkedTargets(source));
		new RelatedNotesModal(this.app, file.basename, suggestions).open();
	}

	private async buildRelatedSuggestions(record: NoteRecord, linkedTargets: Set<string>) {
		const semanticSuggestions = await this.semanticIndex.findRelatedNotesForPath(
			record.path,
			linkedTargets,
			this.settings.seeAlsoCount,
		);
		if (semanticSuggestions.length > 0) {
			return semanticSuggestions;
		}
		return buildSeeAlsoSuggestions(record, this.index, linkedTargets, this.settings);
	}

	private requireRecord(file: TFile): NoteRecord {
		const record = this.index.getByPath(file.path);
		if (!record) {
			throw new Error(`Missing index record for ${file.path}`);
		}
		return record;
	}

	private getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	private findBestMarkdownView(targetPath?: string): MarkdownView | null {
		const activeMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdown?.editor && (!targetPath || activeMarkdown.file?.path === targetPath)) {
			return activeMarkdown;
		}

		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.editor && (!targetPath || view.file?.path === targetPath)) {
				return view;
			}
		}

		if (activeMarkdown?.editor) {
			return activeMarkdown;
		}
		return null;
	}

	private withActiveMarkdownFile(checking: boolean, action: (file: TFile) => Promise<void>): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!file) {
			return false;
		}
		if (!checking) {
			void action(file);
		}
		return true;
	}

	private async handleVaultMutation(action: () => Promise<void>): Promise<void> {
		await action();
		this.bumpVaultRevision();
		this.schedulePluginDataSave();
		this.refreshView();
		this.scheduleViewRefresh();
	}

	private bumpVaultRevision(): void {
		this.vaultRevision += 1;
	}

	private restorePersistedVaultAnalysis(): void {
		this.lastVaultAnalysis = hydrateVaultAnalysis(this.app.vault, this.persistedVaultAnalysisSnapshot);
		if (this.lastVaultAnalysis) {
			removeSuggestionsForTargets(this.lastVaultAnalysis, new Set(this.settings.excludedTargetFiles ?? []));
			recomputeVaultAnalysis(this.lastVaultAnalysis, this.index.getAll());
			this.analysisRevision = this.persistedVaultAnalysisSnapshot?.revision ?? this.vaultRevision;
		}
		if (this.vaultAnalysisJobState.status === "running" || this.vaultAnalysisJobState.status === "updating") {
			this.updateVaultAnalysisJobState({
				status: "failed",
				error: "The previous whole-vault run was interrupted and needs to be restarted.",
				message: "Previous whole-vault analysis was interrupted. Run it again to resume.",
				completedAt: Date.now(),
			});
		}
		this.refreshView();
	}

	private updateVaultAnalysisJobState(partial: Partial<VaultAnalysisJobState>): void {
		this.vaultAnalysisJobState = {
			...this.vaultAnalysisJobState,
			...partial,
			updatedAt: Date.now(),
			stalePaths: partial.stalePaths ? [...partial.stalePaths] : [...this.vaultAnalysisJobState.stalePaths],
		};
		if (partial.status === "running" || partial.status === "updating") {
			this.vaultAnalysisJobState.error = null;
			this.vaultAnalysisJobState.startedAt ??= Date.now();
			this.vaultAnalysisJobState.completedAt = null;
		}
		this.schedulePluginDataSave();
		this.activeVaultReviewModal?.updateProgress(this.getVaultAnalysisJobState());
		this.scheduleViewRefresh();
	}

	private schedulePluginDataSave(delay = 220): void {
		if (this.pluginDataSaveHandle) {
			window.clearTimeout(this.pluginDataSaveHandle);
		}
		this.pluginDataSaveHandle = window.setTimeout(() => {
			this.pluginDataSaveHandle = null;
			void this.savePluginData();
		}, delay);
	}

	private persistCurrentVaultAnalysis(): Promise<void> {
		if (!this.lastVaultAnalysis) {
			this.persistedVaultAnalysisSnapshot = null;
			this.schedulePluginDataSave();
			return Promise.resolve();
		}
		this.persistedVaultAnalysisSnapshot = serializeVaultAnalysis(this.lastVaultAnalysis, this.analysisRevision);
		this.schedulePluginDataSave();
		return Promise.resolve();
	}

	private async ensureVaultAnalysisAvailable(forceRefresh = false, linkMode?: VaultLinkModeChoice): Promise<void> {
		if (this.vaultAnalysisRunPromise) {
			return this.vaultAnalysisRunPromise;
		}
		if (forceRefresh || !this.lastVaultAnalysis) {
			return this.startVaultAnalysisRun("full", linkMode);
		}
		if (this.pendingVaultAnalysisPaths.size > 0 || this.analysisRevision !== this.vaultRevision) {
			this.scheduleVaultAnalysisRefresh(0);
		}
	}

	private startVaultAnalysisRun(mode: "full" | "incremental", linkMode?: VaultLinkModeChoice): Promise<void> {
		if (this.vaultAnalysisRunPromise) {
			return this.vaultAnalysisRunPromise;
		}
		this.vaultAnalysisRunPromise = (async () => {
			try {
				if (mode === "full") {
					await this.runFullVaultAnalysis(linkMode);
				} else {
					await this.runPendingVaultAnalysisRefresh();
				}
			} finally {
				this.vaultAnalysisRunPromise = null;
				if (this.pendingVaultAnalysisPaths.size > 0) {
					this.scheduleVaultAnalysisRefresh();
				}
			}
		})();
		return this.vaultAnalysisRunPromise;
	}

	private async runFullVaultAnalysis(linkMode?: VaultLinkModeChoice): Promise<void> {
		const analysisSettings = linkMode
			? {
				...this.settings,
				enableExactMatching: linkMode.enableExactMatching,
				enableSemanticSuggestions: linkMode.enableSemanticSuggestions,
			}
			: this.settings;
		this.updateVaultAnalysisJobState({
			status: "running",
			mode: "full",
			current: 0,
			total: Math.max(1, this.index.getAll().length * 2),
			message: "Preparing whole-vault analysis...",
			startedAt: Date.now(),
			error: null,
		});

		try {
			const analysis = await analyzeEntireVault(
				this.index,
				analysisSettings,
				this.semanticIndex,
				async (record) => this.app.vault.cachedRead(record.file),
				(progress) => {
					this.handleVaultAnalysisProgress(progress);
				},
			);
			recomputeVaultAnalysis(analysis, this.index.getAll());
			this.lastVaultAnalysis = analysis;
			this.analysisRevision = this.vaultRevision;
			this.persistedVaultAnalysisSnapshot = serializeVaultAnalysis(analysis, this.analysisRevision);
			this.updateVaultAnalysisJobState({
				status: "complete",
				mode: "full",
				current: this.index.getAll().length * 2,
				total: Math.max(1, this.index.getAll().length * 2),
				message: `Whole-vault review is ready with ${analysis.totalSuggestions} accepted suggestion${analysis.totalSuggestions === 1 ? "" : "s"}.`,
				completedAt: Date.now(),
				error: null,
				stalePaths: [...this.pendingVaultAnalysisPaths],
			});
			this.activeVaultReviewModal?.updateAnalysis(analysis);
			this.schedulePluginDataSave();
			this.refreshView();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Whole-vault analysis failed";
			this.updateVaultAnalysisJobState({
				status: "failed",
				mode: "full",
				message,
				error: message,
				completedAt: Date.now(),
			});
			new Notice(message);
		}
	}

	private handleVaultAnalysisProgress(progress: VaultAnalysisRunProgress): void {
		if (progress.preview) {
			removeSuggestionsForTargets(progress.preview, new Set(this.settings.excludedTargetFiles ?? []));
			try {
				this.activeVaultReviewModal?.updateGraphPreview(progress.preview, progress.stage !== "analyzing" || progress.current <= 3);
			} catch {
				// Keep the scan alive if the optional live graph preview cannot render a partial result.
			}
		}
		const records = Math.max(1, this.index.getAll().length);
		const current = progress.stage === "reading"
			? progress.current
			: progress.stage === "analyzing"
				? records + progress.current
				: records * 2;
		const total = progress.stage === "complete" ? records * 2 : records * 2;
		this.updateVaultAnalysisJobState({
			status: "running",
			mode: "full",
			current,
			total,
			message: progress.message,
		});
	}

	private markVaultAnalysisDirty(paths: string[]): void {
		if (!this.lastVaultAnalysis && !this.persistedVaultAnalysisSnapshot) {
			return;
		}
		for (const path of paths) {
			if (!path) {
				continue;
			}
			this.pendingVaultAnalysisPaths.add(path);
		}
		this.updateVaultAnalysisJobState({
			stalePaths: [...this.pendingVaultAnalysisPaths],
			message: this.vaultAnalysisRunPromise
				? this.vaultAnalysisJobState.message
				: `${this.pendingVaultAnalysisPaths.size} note change${this.pendingVaultAnalysisPaths.size === 1 ? "" : "s"} pending whole-vault refresh.`,
		});
		if (!this.vaultAnalysisRunPromise) {
			this.scheduleVaultAnalysisRefresh();
		}
	}

	private scheduleVaultAnalysisRefresh(delay = 1200): void {
		if (!this.lastVaultAnalysis || this.vaultAnalysisRunPromise) {
			return;
		}
		if (this.vaultAnalysisRefreshHandle) {
			window.clearTimeout(this.vaultAnalysisRefreshHandle);
		}
		this.vaultAnalysisRefreshHandle = window.setTimeout(() => {
			this.vaultAnalysisRefreshHandle = null;
			void this.startVaultAnalysisRun("incremental");
		}, delay);
	}

	private async runPendingVaultAnalysisRefresh(): Promise<void> {
		if (!this.lastVaultAnalysis || this.pendingVaultAnalysisPaths.size === 0) {
			return;
		}
		const paths = [...this.pendingVaultAnalysisPaths];
		this.pendingVaultAnalysisPaths.clear();
		this.updateVaultAnalysisJobState({
			status: "updating",
			mode: "incremental",
			current: 0,
			total: Math.max(1, paths.length),
			message: `Refreshing ${paths.length} changed note${paths.length === 1 ? "" : "s"}...`,
			startedAt: Date.now(),
			stalePaths: paths,
		});

		for (let index = 0; index < paths.length; index += 1) {
			const path = paths[index];
			if (!path) {
				continue;
			}
			await this.refreshVaultAnalysisEntry(path);
			recomputeVaultAnalysis(this.lastVaultAnalysis, this.index.getAll());
			this.activeVaultReviewModal?.updateAnalysis(this.lastVaultAnalysis);
			this.persistedVaultAnalysisSnapshot = serializeVaultAnalysis(this.lastVaultAnalysis, this.vaultRevision);
			this.updateVaultAnalysisJobState({
				status: "updating",
				mode: "incremental",
				current: index + 1,
				total: Math.max(1, paths.length),
				message: `Refreshed ${index + 1}/${paths.length} changed note${paths.length === 1 ? "" : "s"}.`,
				stalePaths: paths.slice(index + 1),
			});
		}

		this.analysisRevision = this.vaultRevision;
		this.updateVaultAnalysisJobState({
			status: "complete",
			mode: "incremental",
			current: paths.length,
			total: Math.max(1, paths.length),
			message: paths.length === 0
				? "Whole-vault review is up to date."
				: `Updated whole-vault review for ${paths.length} changed note${paths.length === 1 ? "" : "s"}.`,
			completedAt: Date.now(),
			error: null,
			stalePaths: [],
		});
		this.schedulePluginDataSave();
	}

	private async refreshVaultAnalysisEntry(path: string): Promise<void> {
		if (!this.lastVaultAnalysis) {
			return;
		}
		const existingIndex = this.lastVaultAnalysis.results.findIndex((result) => result.file.path === path);
		const file = this.app.vault.getAbstractFileByPath(path);
		const record = this.index.getByPath(path);
		if (!(file instanceof TFile) || !record) {
			if (existingIndex >= 0) {
				this.lastVaultAnalysis.results.splice(existingIndex, 1);
			}
			delete this.lastVaultAnalysis.sourcesByPath[path];
			return;
		}

		const source = await this.app.vault.read(file);
		const analysis = await analyzeNoteContent(record, source, this.index, this.settings, this.semanticIndex);
		this.lastVaultAnalysis.sourcesByPath[path] = source;
		if (analysis.suggestions.length === 0) {
			if (existingIndex >= 0) {
				this.lastVaultAnalysis.results.splice(existingIndex, 1);
			}
			return;
		}
		if (existingIndex >= 0) {
			this.lastVaultAnalysis.results.splice(existingIndex, 1, analysis);
			return;
		}
		this.lastVaultAnalysis.results.push(analysis);
	}

	private async rebuildSemanticIndex(): Promise<void> {
		await this.runSemanticRebuild({ silent: false, showProgress: true });
	}

	private async runSemanticRebuild(options: { silent: boolean; showProgress: boolean }): Promise<void> {
		if (this.semanticRebuildPromise) {
			return this.semanticRebuildPromise;
		}
		this.semanticRebuildPromise = this.runSemanticRebuildOnce(options);
		try {
			await this.semanticRebuildPromise;
		} finally {
			this.semanticRebuildPromise = null;
		}
	}

	private async runSemanticRebuildOnce(options: { silent: boolean; showProgress: boolean }): Promise<void> {
		await this.ensureIndex();
		const progressModal = this.settings.semanticMode && options.showProgress ? new SemanticBuildProgressModal(this.app) : null;
		progressModal?.open();
		try {
			const status = await this.semanticIndex.rebuild((progress) => {
				this.handleSemanticBuildProgress(progressModal, progress);
			});
			await this.savePluginData();
			this.pendingSemanticPaths.clear();
			if (!options.silent) {
				new Notice(buildSemanticStatusMessage(status));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown semantic build error";
			if (!options.silent) {
				new Notice(`Semantic index failed: ${message}`);
			}
		} finally {
			progressModal?.close();
			this.refreshView();
		}
	}

	private handleSemanticBuildProgress(
		progressModal: SemanticBuildProgressModal | null,
		progress: SemanticBuildProgress,
	): void {
		progressModal?.updateProgress(progress);
	}

	private scheduleViewRefresh(liveOnly = false): void {
		if (this.viewRefreshHandle) {
			window.clearTimeout(this.viewRefreshHandle);
		}
		this.viewRefreshHandle = window.setTimeout(() => {
			this.viewRefreshHandle = null;
			if (liveOnly) {
				this.refreshLiveView();
				return;
			}
			this.refreshView();
		}, 220);
	}

	private scheduleLiveSemanticRefresh(file: TFile, source: string): void {
		if (!this.settings.semanticMode) {
			return;
		}
		this.liveSemanticRefreshKey = `${file.path}::${source.length}::${source.slice(-64)}`;
		if (this.liveSemanticRefreshHandle) {
			window.clearTimeout(this.liveSemanticRefreshHandle);
		}
		this.liveSemanticRefreshHandle = window.setTimeout(() => {
			this.liveSemanticRefreshHandle = null;
			void this.refreshActiveNoteSemanticEmbedding(file, source, this.liveSemanticRefreshKey);
		}, 900);
	}

	private async refreshActiveNoteSemanticEmbedding(file: TFile, source: string, refreshKey: string | null): Promise<void> {
		if (!this.settings.semanticMode || this.liveSemanticRefreshRunning) {
			return;
		}
		if (!refreshKey || refreshKey !== this.liveSemanticRefreshKey) {
			return;
		}
		const record = this.index.getByPath(file.path);
		if (!record) {
			return;
		}
		this.liveSemanticRefreshRunning = true;
		try {
			const updated = await this.semanticIndex.updateFileEmbedding(record, file, source);
			if (updated) {
				if (this.liveSemanticDirtyPath === file.path) {
					this.liveSemanticDirtyPath = null;
				}
				this.refreshView();
			}
		} finally {
			this.liveSemanticRefreshRunning = false;
		}
	}

	private async maybeRunAutoMaintenance(): Promise<void> {
		if (!this.settings.autoRefreshEnabled || this.maintenanceRunning) {
			return;
		}
		if (this.pendingIndexPaths.size === 0 && this.pendingSemanticPaths.size === 0) {
			return;
		}
		const elapsedMs = Date.now() - this.lastAutoMaintenanceAt;
		if (elapsedMs < this.settings.autoRefreshMinutes * 60_000) {
			return;
		}

		this.maintenanceRunning = true;
		try {
			if (this.pendingIndexPaths.size > 0) {
				await this.rebuildIndex();
				this.pendingIndexPaths.clear();
			}
			if (this.settings.semanticMode && this.pendingSemanticPaths.size > 0) {
				await this.runSemanticRebuild({ silent: true, showProgress: false });
			}
			if (this.pendingVaultAnalysisPaths.size > 0 && this.lastVaultAnalysis && !this.vaultAnalysisRunPromise) {
				await this.startVaultAnalysisRun("incremental");
			}
			this.lastAutoMaintenanceAt = Date.now();
		} finally {
			this.maintenanceRunning = false;
		}
	}
}

function sidebarSuggestionPriority(suggestion: LinkSuggestion): number {
	switch (suggestion.matchType) {
		case "title":
			return 3;
		case "acronym":
			return 2.5;
		case "alias":
			return 2;
		case "semantic":
			return 1;
		default:
			return 0;
	}
}

function cursorSuggestionPriority(suggestion: LinkSuggestion, cursorOffset: number | null): number {
	if (cursorOffset === null) {
		return Number.POSITIVE_INFINITY;
	}
	if (cursorOffset >= suggestion.start && cursorOffset <= suggestion.end) {
		return -1;
	}
	if (cursorOffset < suggestion.start) {
		return suggestion.start - cursorOffset;
	}
	return cursorOffset - suggestion.end;
}

function getSelectionOffsets(editor: Editor, source: string): Range | null {
	const from = editor.posToOffset(editor.getCursor("from"));
	const to = editor.posToOffset(editor.getCursor("to"));
	if (from === to) {
		return null;
	}
	return {
		start: Math.max(0, Math.min(from, to)),
		end: Math.min(source.length, Math.max(from, to)),
	};
}

function extractLinkedTargets(source: string): Set<string> {
	return new Set(
		Array.from(source.matchAll(/\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?]]/g), (match) =>
			match[1]?.trim() ?? "",
		).filter(Boolean),
	);
}

function buildSemanticStatusMessage(status: SemanticIndexStatus): string {
	const availability = status.available ? "ready" : status.reason ?? "unavailable";
	return `Semantic index: ${status.cachedCount}/${status.noteCount} cached with ${status.providerLabel} (${availability})`;
}

function normalizeVaultPath(value: string): string {
	return value.trim().replace(/\\/g, "/");
}

function normalizeVaultPathList(paths: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const path of paths) {
		const nextPath = normalizeVaultPath(path);
		if (!nextPath || seen.has(nextPath)) {
			continue;
		}
		seen.add(nextPath);
		normalized.push(nextPath);
	}
	return normalized.sort((left, right) => left.localeCompare(right));
}

function sameStringList(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}

function removeSuggestionsForTargets(analysis: VaultAnalysisResult, excludedTargetPaths: Set<string>): number {
	if (excludedTargetPaths.size === 0) {
		return 0;
	}

	let removedCount = 0;
	analysis.results = analysis.results
		.map((result) => {
			const suggestions = result.suggestions.filter((suggestion) => {
				const keep = !excludedTargetPaths.has(suggestion.targetPath);
				if (!keep) {
					removedCount += 1;
				}
				return keep;
			});
			return {
				...result,
				suggestions,
			};
		})
		.filter((result) => result.suggestions.length > 0);
	return removedCount;
}

function isPluginStorageDataShape(value: unknown): value is Partial<PluginStorageData & SemanticAutoLinkerSettings> {
	return value === null || typeof value === "object";
}

function migrateLoadedSettings(settingsSource: Partial<SemanticAutoLinkerSettings>): { settings: SemanticAutoLinkerSettings; migrated: boolean } {
	const settings = Object.assign({}, DEFAULT_SETTINGS, settingsSource);
	let migrated = false;

	if (!isKnownSemanticProvider(settings.semanticProviderId)) {
		settings.semanticProviderId = DEFAULT_SETTINGS.semanticProviderId;
		migrated = true;
	}

	const hadTransformersModel = hasOwnSetting(settingsSource, "semanticTransformersModel");
	const hadOldDefaultOllamaProvider = settings.semanticProviderId === "ollama"
		&& !hadTransformersModel
		&& settings.semanticOllamaBaseUrl === DEFAULT_SETTINGS.semanticOllamaBaseUrl
		&& settings.semanticOllamaModel === DEFAULT_SETTINGS.semanticOllamaModel;
	if (hadOldDefaultOllamaProvider) {
		settings.semanticProviderId = DEFAULT_SETTINGS.semanticProviderId;
		migrated = true;
	}

	if (settings.semanticMode !== DEFAULT_SETTINGS.semanticMode && !hasOwnSetting(settingsSource, "semanticProviderId")) {
		settings.semanticMode = DEFAULT_SETTINGS.semanticMode;
		migrated = true;
	}

	return { settings, migrated };
}

function isKnownSemanticProvider(providerId: string): boolean {
	return providerId === "none" || providerId === "transformers" || providerId === "local-fallback" || providerId === "ollama";
}

function hasOwnSetting(settingsSource: Partial<SemanticAutoLinkerSettings>, key: keyof SemanticAutoLinkerSettings): boolean {
	return Object.prototype.hasOwnProperty.call(settingsSource, key);
}

function buildFooterSuggestionsFromAccepted(suggestions: LinkSuggestion[]): RelatedNoteSuggestion[] {
	const byTarget = new Map<string, RelatedNoteSuggestion>();
	for (const suggestion of suggestions) {
		if (byTarget.has(suggestion.targetPath)) {
			continue;
		}
		byTarget.set(suggestion.targetPath, {
			targetPath: suggestion.targetPath,
			targetTitle: suggestion.targetTitle,
			targetLink: suggestion.targetLink,
			reason: `${suggestion.reason} from "${suggestion.matchedText}"`,
			score: Math.round(suggestion.confidence * 100),
			previewText: suggestion.context,
			matchType: suggestion.matchType === "semantic" ? "semantic" : "deterministic",
			accepted: true,
		});
	}
	return [...byTarget.values()];
}
