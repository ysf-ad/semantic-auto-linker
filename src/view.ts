import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type SemanticAutoLinkerPlugin from "./main";
import type { LinkSuggestion, VaultAnalysisResult } from "./types";

export const SEMANTIC_AUTO_LINKER_VIEW_TYPE = "semantic-auto-linker-view";

export class SemanticAutoLinkerView extends ItemView {
	private plugin: SemanticAutoLinkerPlugin;
	private suggestionsSection: HTMLDivElement | null = null;
	private statusSection: HTMLDivElement | null = null;
	private actionsSection: HTMLDivElement | null = null;
	private summarySection: HTMLDivElement | null = null;
	private renderVersion = 0;

	constructor(leaf: WorkspaceLeaf, plugin: SemanticAutoLinkerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SEMANTIC_AUTO_LINKER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Semantic auto-linker";
	}

	getIcon(): string {
		return "git-branch";
	}

	async onOpen(): Promise<void> {
		this.ensureShell();
		await this.render();
	}

	async render(): Promise<void> {
		this.ensureShell();
		const renderVersion = ++this.renderVersion;

		if (this.suggestionsSection) {
			await renderSidebarAutoLinkSuggestions(this.suggestionsSection, this.plugin, renderVersion, () => this.renderVersion);
		}
		if (this.statusSection) {
			renderStatusSection(this.statusSection, this.plugin);
		}
		if (this.actionsSection) {
			renderActionSection(this.actionsSection, this.plugin);
		}
		if (this.summarySection) {
			renderAnalysisSummary(this.summarySection, this.plugin.getLastVaultAnalysis());
		}
	}

	async refreshLive(): Promise<void> {
		this.ensureShell();
		const renderVersion = ++this.renderVersion;
		if (this.suggestionsSection) {
			await renderSidebarAutoLinkSuggestions(this.suggestionsSection, this.plugin, renderVersion, () => this.renderVersion);
		}
		if (this.statusSection) {
			renderStatusSection(this.statusSection, this.plugin);
		}
	}

	private ensureShell(): void {
		if (this.suggestionsSection && this.statusSection && this.actionsSection && this.summarySection) {
			return;
		}

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("semantic-auto-linker-view");
		this.suggestionsSection = contentEl.createDiv({ cls: "semantic-auto-linker-surface semantic-auto-linker-suggestions-surface" });
		this.statusSection = contentEl.createDiv({ cls: "semantic-auto-linker-surface" });
		this.actionsSection = contentEl.createDiv({ cls: "semantic-auto-linker-surface" });
		this.summarySection = contentEl.createDiv({ cls: "semantic-auto-linker-surface" });
	}
}

async function renderSidebarAutoLinkSuggestions(
	containerEl: HTMLElement,
	plugin: SemanticAutoLinkerPlugin,
	renderVersion: number,
	getCurrentRenderVersion: () => number,
): Promise<void> {
	const previousList = containerEl.querySelector<HTMLDivElement>(".semantic-auto-linker-related-list");
	const previousScrollTop = previousList?.scrollTop ?? 0;
	let titleEl = containerEl.querySelector<HTMLDivElement>(".semantic-auto-linker-section-title");
	let listEl = containerEl.querySelector<HTMLDivElement>(".semantic-auto-linker-related-list");
	if (!titleEl || !listEl) {
		containerEl.empty();
		titleEl = containerEl.createDiv({ text: "Auto-Link suggestions", cls: "semantic-auto-linker-section-title" });
		listEl = containerEl.createDiv({ cls: "semantic-auto-linker-related-list is-live" });
		listEl.createDiv({ text: "Checking the active note...", cls: "semantic-auto-linker-empty-state" });
	}
	const related = await plugin.getSidebarAutoLinkSuggestions();
	if (renderVersion !== getCurrentRenderVersion()) {
		return;
	}

	if (!related) {
		titleEl.setText("Auto-link suggestions");
		updateStableSuggestionList(listEl, "no-active-note", () => {
			listEl.empty();
			listEl.createDiv({ text: "Open a Markdown note to see suggestions.", cls: "semantic-auto-linker-empty-state" });
		});
		return;
	}

	titleEl.setText(`Auto-Link suggestions for ${related.noteTitle}`);
	const signature = buildSidebarSuggestionSignature(related.noteTitle, related.suggestions);

	if (related.suggestions.length === 0) {
		updateStableSuggestionList(listEl, signature, () => {
			listEl.empty();
			listEl.createDiv({
				text: "No inline auto-link suggestions for the current note yet.",
				cls: "semantic-auto-linker-empty-state",
			});
		});
		return;
	}

	updateStableSuggestionList(listEl, signature, () => {
		listEl.empty();
		for (const suggestion of related.suggestions) {
			createRelatedRow(listEl, plugin, suggestion);
		}
		listEl.scrollTop = previousScrollTop;
	});
}

function buildSidebarSuggestionSignature(noteTitle: string, suggestions: LinkSuggestion[]): string {
	return [
		noteTitle,
		...suggestions.map((suggestion) =>
			`${suggestion.id}:${suggestion.targetPath}:${suggestion.start}:${suggestion.end}:${suggestion.confidence.toFixed(3)}`,
		),
	].join("|");
}

function updateStableSuggestionList(listEl: HTMLDivElement, signature: string, update: () => void): void {
	if (listEl.dataset.suggestionSignature === signature) {
		return;
	}
	listEl.dataset.suggestionSignature = signature;
	update();
}

function renderStatusSection(containerEl: HTMLElement, plugin: SemanticAutoLinkerPlugin): void {
	containerEl.empty();
	const semanticStatus = plugin.getSemanticStatus();
	const activeSemantic = plugin.getActiveSemanticIndicator();
	containerEl.createDiv({ text: "Status", cls: "semantic-auto-linker-section-title" });

	const cards = containerEl.createDiv({ cls: "semantic-auto-linker-status-grid" });
	createMetricCard(cards, "Indexed notes", String(plugin.getIndexSize()));
	createMetricCard(cards, "Semantic cache", `${semanticStatus.cachedCount}/${semanticStatus.noteCount}`);
	createMetricCard(cards, "Provider", semanticStatus.providerLabel);
	createMetricCard(cards, "Mode", plugin.settings.semanticMode ? "Enabled" : "Disabled");

	const progressShell = containerEl.createDiv({ cls: "semantic-auto-linker-status-progress" });
	const progressTrack = progressShell.createDiv({ cls: "semantic-auto-linker-status-progress-track" });
	const progressFill = progressTrack.createDiv({ cls: "semantic-auto-linker-status-progress-fill" });
	const ratio = semanticStatus.noteCount > 0 ? semanticStatus.cachedCount / semanticStatus.noteCount : 0;
	progressFill.setCssProps({ width: `${Math.max(6, Math.round(ratio * 100))}%` });
	progressShell.createDiv({
		text: semanticStatus.noteCount > 0
			? `${Math.round(ratio * 100)}% cached${semanticStatus.pendingCount > 0 ? ` • ${semanticStatus.pendingCount} pending` : ""}`
			: "Semantic cache not built yet.",
		cls: "semantic-auto-linker-status-progress-copy",
	});

	const freshness = containerEl.createDiv({ cls: "semantic-auto-linker-active-semantic" });
	const dot = freshness.createSpan({ cls: `semantic-auto-linker-active-semantic-dot is-${activeSemantic.state}` });
	dot.ariaLabel = activeSemantic.fileTitle
		? `Active note semantic state: ${activeSemantic.state}`
		: "No active note";
	dot.title = activeSemantic.fileTitle
		? activeSemantic.state === "dirty"
			? `${activeSemantic.fileTitle} has unsynced live semantic changes`
			: activeSemantic.state === "refreshing"
				? `Refreshing semantic embedding for ${activeSemantic.fileTitle}`
				: `${activeSemantic.fileTitle} is semantically up to date`
		: "No active note";
	freshness.createSpan({
		text: activeSemantic.fileTitle ? "Active note" : "No active note",
		cls: "semantic-auto-linker-active-semantic-copy",
	});
}

function renderActionSection(containerEl: HTMLElement, plugin: SemanticAutoLinkerPlugin): void {
	containerEl.empty();
	containerEl.createDiv({ text: "Actions", cls: "semantic-auto-linker-section-title" });
	const grid = containerEl.createDiv({ cls: "semantic-auto-linker-action-grid" });
	const vaultAnalysisJob = plugin.getVaultAnalysisJobState();
	const showVaultProgress = vaultAnalysisJob.status === "running" || vaultAnalysisJob.status === "updating";
	const vaultRatio = showVaultProgress && vaultAnalysisJob.total > 0
		? Math.max(0.04, Math.min(1, vaultAnalysisJob.current / vaultAnalysisJob.total))
		: null;

	createActionButton(grid, {
		label: "Build semantic embeddings",
		description: "Generate or refresh semantic cache",
		icon: "brain-circuit",
		variant: "embeddings",
		onClick: () => {
			void plugin.rebuildSemanticIndexFromView();
		},
	});
	createActionButton(grid, {
		label: "Auto-Link whole vault",
		description: showVaultProgress
			? vaultAnalysisJob.message
			: plugin.hasPendingVaultAnalysisUpdates()
				? "Open saved review while changed notes refresh in the background"
				: "Open review across the vault",
		icon: "scan-search",
		variant: "vault",
		progress: vaultRatio,
		badge: showVaultProgress
			? `${Math.min(vaultAnalysisJob.current, vaultAnalysisJob.total)}/${vaultAnalysisJob.total}`
			: plugin.getLastVaultAnalysis()
				? plugin.hasPendingVaultAnalysisUpdates()
					? "stale"
					: "ready"
				: null,
		onClick: () => {
			void plugin.runVaultAnalysisFromView();
		},
	});
	createActionButton(grid, {
		label: "Auto-Link current note",
		description: "Review inline link suggestions",
		icon: "file-search",
		variant: "note",
		onClick: () => {
			void plugin.runCurrentNoteAnalysisFromView();
		},
	});
	createActionButton(grid, {
		label: "Open embedding explorer",
		description: "Explore note and concept space",
		icon: "orbit",
		variant: "explorer",
		onClick: () => {
			void plugin.showEmbeddingExplorerFromView();
		},
	});
	createActionButton(grid, {
		label: "Refresh note index",
		description: "Re-scan titles, aliases, and files",
		icon: "refresh-cw",
		variant: "index",
		onClick: () => {
			void plugin.rebuildIndex("Note index rebuilt");
		},
	});
}

function renderAnalysisSummary(containerEl: HTMLElement, analysis: VaultAnalysisResult | null): void {
	containerEl.empty();
	containerEl.createDiv({ text: "Vault preview", cls: "semantic-auto-linker-section-title" });

	if (!analysis) {
		containerEl.createDiv({
			text: "Run whole-vault analysis to preview affected notes and projected link growth.",
			cls: "semantic-auto-linker-empty-state",
		});
		return;
	}

	const metricsGrid = containerEl.createDiv({ cls: "semantic-auto-linker-preview-grid" });
	createPreviewChip(metricsGrid, "Files with suggestions", String(analysis.filesWithSuggestions));
	createPreviewChip(metricsGrid, "Added links", String(analysis.graphMetrics.projectedAddedLinks));
	createPreviewChip(metricsGrid, "Current links", String(analysis.graphMetrics.existingLinkCount));
	createPreviewChip(metricsGrid, "Projected links", String(analysis.graphMetrics.projectedLinkCount));
}

function createMetricCard(containerEl: HTMLElement, label: string, value: string): void {
	const card = containerEl.createDiv({ cls: "semantic-auto-linker-metric-card" });
	card.createDiv({ text: label, cls: "semantic-auto-linker-metric-label" });
	card.createDiv({ text: value, cls: "semantic-auto-linker-metric-value" });
}

function createPreviewChip(containerEl: HTMLElement, label: string, value: string): void {
	const chip = containerEl.createDiv({ cls: "semantic-auto-linker-preview-chip" });
	chip.createDiv({ text: value, cls: "semantic-auto-linker-preview-value" });
	chip.createDiv({ text: label, cls: "semantic-auto-linker-preview-label" });
}

function createRelatedRow(containerEl: HTMLElement, plugin: SemanticAutoLinkerPlugin, suggestion: LinkSuggestion): void {
	const card = containerEl.createDiv({ cls: "semantic-auto-linker-related-row" });
	card.tabIndex = 0;
	card.setAttribute("role", "button");

	const header = card.createDiv({ cls: "semantic-auto-linker-related-header" });
	header.createDiv({
		text: `"${suggestion.matchedText}"`,
		cls: "semantic-auto-linker-related-title",
	});
	header.createDiv({
		text: `[[${suggestion.targetTitle}]]`,
		cls: "semantic-auto-linker-related-target",
	});

	card.createDiv({
		text: `${suggestion.reason} • ${Math.round(suggestion.confidence * 100)}%`,
		cls: "semantic-auto-linker-related-meta",
	});
	card.createDiv({
		text: suggestion.context,
		cls: "semantic-auto-linker-related-preview",
	});
	const actions = card.createDiv({ cls: "semantic-auto-linker-related-actions" });
	const exclude = actions.createEl("button", {
		cls: "semantic-auto-linker-related-action",
		attr: {
			type: "button",
			"aria-label": `Exclude ${suggestion.targetTitle} from matching`,
		},
	});
	setIcon(exclude.createSpan(), "ban");
	exclude.createSpan({ text: "Exclude target" });
	exclude.title = `Stop suggesting links to ${suggestion.targetTitle}`;
	exclude.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		void withButtonBusy(exclude, "Excluding...", async () => {
			card.addClass("is-pending");
			await plugin.excludeTargetFromMatching(suggestion.targetPath, suggestion.targetTitle);
		});
	};

	const apply = async () => {
		await withElementBusy(card, "Applying...", async () => {
			await plugin.applySidebarSuggestion(suggestion);
		});
	};
	card.onclick = () => {
		void apply();
	};
	card.onkeydown = (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			void apply();
		}
	};
}

function createActionButton(
	containerEl: HTMLElement,
	options: {
		label: string;
		description: string;
		icon: string;
		onClick: () => void | Promise<void>;
		progress?: number | null;
		badge?: string | null;
		variant: "embeddings" | "vault" | "note" | "explorer" | "index";
	},
): void {
	const button = containerEl.createEl("button", {
		cls: `semantic-auto-linker-action-card is-${options.variant}`,
	});
	const leading = button.createSpan({ cls: "semantic-auto-linker-action-leading" });
	const iconWrap = leading.createSpan({ cls: "semantic-auto-linker-action-icon" });
	setIcon(iconWrap, options.icon);

	const body = button.createSpan({ cls: "semantic-auto-linker-action-body" });
	body.createSpan({ text: options.label, cls: "semantic-auto-linker-action-title" });
	body.createSpan({ text: options.description, cls: "semantic-auto-linker-action-copy" });
	if (options.progress !== undefined && options.progress !== null) {
		const progress = body.createSpan({ cls: "semantic-auto-linker-action-progress" });
		progress.createSpan({
			cls: "semantic-auto-linker-action-progress-fill",
			attr: { style: `width: ${Math.round(options.progress * 100)}%` },
		});
	}

	const trailing = button.createSpan({ cls: "semantic-auto-linker-action-trailing" });
	if (options.badge) {
		trailing.addClass("semantic-auto-linker-action-trailing-badge");
		trailing.setText(options.badge);
	} else {
		setIcon(trailing, "arrow-right");
	}

	button.onclick = () => {
		void withElementBusy(button, "Working...", async () => {
			await options.onClick();
		});
	};
}

async function withElementBusy(element: HTMLElement, busyLabel: string, action: () => Promise<void>): Promise<void> {
	if (element.hasClass("is-loading")) {
		return;
	}
	element.addClass("is-loading");
	element.setAttribute("aria-busy", "true");
	const busy = element.createSpan({ cls: "semantic-auto-linker-button-busy", text: busyLabel });
	if (element instanceof HTMLButtonElement) {
		element.disabled = true;
	}
	try {
		await action();
	} finally {
		busy.remove();
		element.removeClass("is-loading");
		element.removeAttribute("aria-busy");
		if (element instanceof HTMLButtonElement) {
			element.disabled = false;
		}
	}
}

async function withButtonBusy(button: HTMLButtonElement, busyText: string, action: () => Promise<void>): Promise<void> {
	if (button.disabled) {
		return;
	}
	const previousText = button.textContent ?? "";
	button.disabled = true;
	button.addClass("is-loading");
	button.setText(busyText);
	try {
		await action();
	} finally {
		button.disabled = false;
		button.removeClass("is-loading");
		button.setText(previousText);
	}
}
