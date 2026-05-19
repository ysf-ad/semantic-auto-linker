import { Modal, setIcon, Setting } from "obsidian";
import type { AnalysisResult, LinkSuggestion, RelatedNoteSuggestion, SemanticAutoLinkerSettings, VaultAnalysisJobState, VaultAnalysisResult } from "./types";
import { GraphPreviewPanel } from "./graph-modal";

export type ReviewInsertionMode = "inline" | "footer";

type ApplyHandler = (payload: {
	suggestions: LinkSuggestion[];
	mode: ReviewInsertionMode;
	useDisplayTitle: boolean;
}) => Promise<void>;
type VaultFilterMode = "all" | "semantic" | "deterministic" | "accepted" | "unchecked";
type VaultGroupSortMode = "name" | "most-suggestions" | "highest-confidence" | "lowest-confidence";
type VaultSuggestionSortMode = "document" | "highest-confidence" | "lowest-confidence";

export class LinkReviewModal extends Modal {
	private analysis: AnalysisResult;
	private onApply: ApplyHandler;
	private settings: SemanticAutoLinkerSettings;
	private insertionMode: ReviewInsertionMode = "inline";
	private useDisplayTitle = true;

	constructor(app: Modal["app"], analysis: AnalysisResult, settings: SemanticAutoLinkerSettings, onApply: ApplyHandler) {
		super(app);
		this.analysis = analysis;
		this.settings = settings;
		this.onApply = onApply;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(`Review ${this.analysis.scopeLabel} suggestions`);
		contentEl.empty();
		contentEl.addClass("semantic-auto-linker-modal");

		contentEl.createEl("p", {
			text: `${this.analysis.suggestions.length} suggestion${this.analysis.suggestions.length === 1 ? "" : "s"} found for ${this.analysis.file.basename}.`,
		});

		if (this.analysis.suggestions.length === 0) {
			new Setting(contentEl).addButton((button) =>
				button.setButtonText("Close").setCta().onClick(() => this.close()),
			);
			return;
		}

		const actionRow = contentEl.createDiv({ cls: "semantic-auto-linker-actions" });
		const modeRow = contentEl.createDiv({ cls: "semantic-auto-linker-mode-row" });
		const modeLabel = modeRow.createDiv({ cls: "semantic-auto-linker-mode-label" });
		modeLabel.setText("Insertion");
		createInsertionModeToggle(
			modeRow,
			this.insertionMode,
			(nextMode) => {
				this.insertionMode = nextMode;
				apply.setText(this.insertionMode === "footer" ? "Update footer" : "Apply accepted");
					displayTitleOption.setCssProps({ display: this.insertionMode === "footer" ? "" : "none" });
			},
		);
		createModeInfo(modeRow, "Inline updates matched text in place. Footer keeps the note body unchanged and writes accepted targets into the footer section.");

		const acceptAll = actionRow.createEl("button", { text: "Accept all", cls: "mod-cta" });
		const rejectAll = actionRow.createEl("button", { text: "Reject all" });
		const apply = actionRow.createEl("button", { text: "Apply accepted", cls: "mod-cta" });
		const displayTitleOption = actionRow.createEl("label", { cls: "semantic-auto-linker-footer-option" });
		displayTitleOption.setCssProps({ display: "none" });
		const displayTitleCheckbox = displayTitleOption.createEl("input", { type: "checkbox" });
		displayTitleCheckbox.checked = this.useDisplayTitle;
		displayTitleCheckbox.onchange = () => {
			this.useDisplayTitle = displayTitleCheckbox.checked;
		};
		displayTitleOption.createSpan({ text: "Show note title in footer" });

		acceptAll.onclick = () => {
			this.analysis.suggestions.forEach((suggestion) => {
				suggestion.accepted = true;
			});
			this.refreshRows();
		};

		createThresholdAcceptMenu(actionRow, this.settings, () => {
			applyAcceptanceThreshold(this.analysis.suggestions, this.settings.semanticAcceptanceThreshold);
			this.refreshRows();
		});

		rejectAll.onclick = () => {
			this.analysis.suggestions.forEach((suggestion) => {
				suggestion.accepted = false;
			});
			this.refreshRows();
		};

		apply.onclick = async () => {
			await this.onApply({
				suggestions: this.analysis.suggestions.filter((suggestion) => suggestion.accepted),
				mode: this.insertionMode,
				useDisplayTitle: this.useDisplayTitle,
			});
			this.close();
		};

		const listEl = contentEl.createDiv({ cls: "semantic-auto-linker-list" });
		for (const suggestion of this.analysis.suggestions) {
			const row = listEl.createDiv({ cls: "semantic-auto-linker-row" });
			row.dataset.suggestionId = suggestion.id;

			const checkbox = row.createEl("input", { type: "checkbox" });
			checkbox.checked = suggestion.accepted;
			checkbox.onchange = () => {
				suggestion.accepted = checkbox.checked;
			};

			const body = row.createDiv({ cls: "semantic-auto-linker-row-body" });
			body.createDiv({
				text: `"${suggestion.matchedText}" -> [[${suggestion.targetTitle}]]`,
				cls: "semantic-auto-linker-row-title",
			});
			body.createDiv({
				text: `${suggestion.reason} | ${(suggestion.confidence * 100).toFixed(0)}%`,
				cls: "semantic-auto-linker-row-meta",
			});
			const details = body.createEl("details", { cls: "semantic-auto-linker-row-details" });
			details.createEl("summary", { text: "Preview" });
			details.createDiv({
				text: suggestion.context,
				cls: "semantic-auto-linker-row-context",
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private refreshRows(): void {
		this.contentEl.querySelectorAll<HTMLInputElement>(".semantic-auto-linker-row input[type='checkbox']").forEach((input) => {
			const row = input.closest<HTMLElement>(".semantic-auto-linker-row");
			const suggestion = this.analysis.suggestions.find((item) => item.id === row?.dataset.suggestionId);
			if (!suggestion) {
				return;
			}
			input.checked = suggestion.accepted;
		});
	}
}

export class VaultReviewModal extends Modal {
	private analysis: VaultAnalysisResult | null;
	private onApply: (analysis: VaultAnalysisResult, mode: ReviewInsertionMode, useDisplayTitle: boolean) => Promise<void>;
	private onChange: () => void;
	private settings: SemanticAutoLinkerSettings;
	private graphPanel: GraphPreviewPanel | null = null;
	private graphHostEl: HTMLElement | null = null;
	private summaryPrimaryEl: HTMLElement | null = null;
	private summarySecondaryEl: HTMLElement | null = null;
	private progressShellEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private progressCopyEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private rightPaneEl: HTMLElement | null = null;
	private filterMode: VaultFilterMode = "all";
	private groupSortMode: VaultGroupSortMode = "name";
	private suggestionSortMode: VaultSuggestionSortMode = "document";
	private expandedGroups = new Set<string>();
	private groupSortControlEl: HTMLElement | null = null;
	private groupButtonsControlEl: HTMLElement | null = null;
	private onClosed?: () => void;
	private insertionMode: ReviewInsertionMode = "inline";
	private useDisplayTitle = true;

	constructor(app: Modal["app"], analysis: VaultAnalysisResult | null, settings: SemanticAutoLinkerSettings, onApply: (analysis: VaultAnalysisResult, mode: ReviewInsertionMode, useDisplayTitle: boolean) => Promise<void>, onChange: () => void, onClosed?: () => void) {
		super(app);
		this.analysis = analysis;
		this.settings = settings;
		this.onApply = onApply;
		this.onChange = onChange;
		this.onClosed = onClosed;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Review whole vault suggestions");
		contentEl.empty();
		contentEl.addClass("semantic-auto-linker-modal");
		contentEl.addClass("semantic-auto-linker-vault-review");
			this.modalEl.setCssProps({
				width: "min(1380px, 96vw)",
				maxWidth: "96vw",
				height: "min(900px, 88vh)",
			});
			this.contentEl.setCssProps({ height: "100%" });

		const summary = contentEl.createDiv({ cls: "semantic-auto-linker-vault-summary" });
		this.summaryPrimaryEl = summary.createDiv();
		this.summarySecondaryEl = summary.createDiv();
		this.progressShellEl = summary.createDiv({ cls: "semantic-auto-linker-vault-progress" });
		const track = this.progressShellEl.createDiv({ cls: "semantic-auto-linker-vault-progress-track" });
		this.progressFillEl = track.createDiv({ cls: "semantic-auto-linker-vault-progress-fill" });
		this.progressCopyEl = this.progressShellEl.createDiv({ cls: "semantic-auto-linker-vault-progress-copy" });
		this.renderSummary();

		const panes = contentEl.createDiv({ cls: "semantic-auto-linker-vault-panes" });
		const graphSection = panes.createDiv({ cls: "semantic-auto-linker-review-graph" });
		graphSection.createEl("h3", { text: "Graph impact preview" });
		this.graphHostEl = graphSection.createDiv();
		if (this.analysis) {
			this.graphPanel = new GraphPreviewPanel(this.app, this.graphHostEl, this.analysis, "after");
		} else {
			this.graphHostEl.createDiv({
				text: "Building whole-vault review and graph preview...",
				cls: "semantic-auto-linker-empty-state",
			});
		}

		const rightPane = panes.createDiv({ cls: "semantic-auto-linker-vault-list-pane" });
		this.rightPaneEl = rightPane;
		const modeRow = rightPane.createDiv({ cls: "semantic-auto-linker-mode-row" });
		const modeLabel = modeRow.createDiv({ cls: "semantic-auto-linker-mode-label" });
		modeLabel.setText("Insertion");
		createInsertionModeToggle(
			modeRow,
			this.insertionMode,
			(nextMode) => {
				this.insertionMode = nextMode;
				apply.setText(this.insertionMode === "footer" ? "Update footers" : "Apply accepted");
					displayTitleOption.setCssProps({ display: this.insertionMode === "footer" ? "" : "none" });
			},
		);
		createModeInfo(modeRow, "Inline applies accepted matches inside note text. Footer leaves note text unchanged and writes the accepted targets into each note's footer section.");
		const actionRow = rightPane.createDiv({ cls: "semantic-auto-linker-actions" });
		const acceptAll = actionRow.createEl("button", { text: "Accept all", cls: "mod-cta" });
		const rejectAll = actionRow.createEl("button", { text: "Reject all" });
		const apply = actionRow.createEl("button", { text: "Apply accepted", cls: "mod-cta" });
		const displayTitleOption = actionRow.createEl("label", { cls: "semantic-auto-linker-footer-option" });
		displayTitleOption.setCssProps({ display: "none" });
		const displayTitleCheckbox = displayTitleOption.createEl("input", { type: "checkbox" });
		displayTitleCheckbox.checked = this.useDisplayTitle;
		displayTitleCheckbox.onchange = () => {
			this.useDisplayTitle = displayTitleCheckbox.checked;
		};
		displayTitleOption.createSpan({ text: "Show note title in footer" });
		const controlsRow = rightPane.createDiv({ cls: "semantic-auto-linker-vault-controls" });

		acceptAll.onclick = () => {
			this.setAcceptedState(true);
		};
		createThresholdAcceptMenu(actionRow, this.settings, () => {
			this.applyAcceptanceThreshold();
		});

		rejectAll.onclick = () => {
			this.setAcceptedState(false);
		};

		apply.onclick = async () => {
			if (!this.analysis) {
				return;
			}
			await this.onApply(this.analysis, this.insertionMode, this.useDisplayTitle);
			this.close();
		};

		this.renderControls(controlsRow);
		this.listEl = rightPane.createDiv({ cls: "semantic-auto-linker-list semantic-auto-linker-vault-results" });
		this.renderResultList();
	}

	onClose(): void {
		this.onClosed?.();
		this.graphPanel?.destroy();
		this.graphPanel = null;
		this.graphHostEl = null;
		this.contentEl.empty();
		this.modalEl.setCssProps({
			width: "",
			maxWidth: "",
			height: "",
		});
		this.contentEl.setCssProps({ height: "" });
	}

	private setAcceptedState(value: boolean): void {
		if (!this.analysis) {
			return;
		}
		for (const result of this.analysis.results) {
			for (const suggestion of result.suggestions) {
				suggestion.accepted = value;
			}
		}
		this.onChange();
		this.graphPanel?.updateAnalysis(this.analysis);
		this.renderResultList();
	}

	private applyAcceptanceThreshold(): void {
		if (!this.analysis) {
			return;
		}
		for (const result of this.analysis.results) {
			applyAcceptanceThreshold(result.suggestions, this.settings.semanticAcceptanceThreshold);
		}
		this.onChange();
		this.graphPanel?.updateAnalysis(this.analysis);
		this.renderResultList();
	}

	private renderControls(containerEl: HTMLElement): void {
		this.renderSelectControl(
			containerEl,
			"Filter",
			this.filterMode,
			[
				{ value: "all", label: "All" },
				{ value: "semantic", label: "Semantic only" },
				{ value: "deterministic", label: "Deterministic only" },
				{ value: "accepted", label: "Accepted only" },
				{ value: "unchecked", label: "Unchecked only" },
			],
			(value) => {
				this.filterMode = value as VaultFilterMode;
				this.renderResultList();
			},
		);
		this.renderSelectControl(
			containerEl,
			"Sort files",
			this.groupSortMode,
			[
				{ value: "name", label: "Name" },
				{ value: "most-suggestions", label: "Most suggestions" },
				{ value: "highest-confidence", label: "Highest confidence" },
				{ value: "lowest-confidence", label: "Lowest confidence" },
			],
			(value) => {
				this.groupSortMode = value as VaultGroupSortMode;
				this.renderResultList();
			},
		);
		this.groupSortControlEl = containerEl.lastElementChild as HTMLElement | null;
		this.renderSelectControl(
			containerEl,
			"Sort suggestions",
			this.suggestionSortMode,
			[
				{ value: "highest-confidence", label: "Highest confidence" },
				{ value: "lowest-confidence", label: "Lowest confidence" },
				{ value: "document", label: "Document order" },
			],
			(value) => {
				this.suggestionSortMode = value as VaultSuggestionSortMode;
				this.renderResultList();
			},
		);

		const expandControls = containerEl.createDiv({ cls: "semantic-auto-linker-vault-control semantic-auto-linker-vault-control-buttons" });
		this.groupButtonsControlEl = expandControls;
		expandControls.createEl("label", { text: "Groups" });
		const buttons = expandControls.createDiv({ cls: "semantic-auto-linker-vault-inline-buttons" });
		buttons.createEl("button", { text: "Expand all" }).onclick = () => {
			if (!this.analysis) {
				return;
			}
			for (const result of this.analysis.results) {
				this.expandedGroups.add(result.file.path);
			}
			this.renderResultList();
		};
		buttons.createEl("button", { text: "Collapse all" }).onclick = () => {
			this.expandedGroups.clear();
			this.renderResultList();
		};
		this.updateControlVisibility();
	}

	private renderSelectControl(
		containerEl: HTMLElement,
		label: string,
		currentValue: string,
		options: Array<{ value: string; label: string }>,
		onChange: (value: string) => void,
	): void {
		const wrapper = containerEl.createDiv({ cls: "semantic-auto-linker-vault-control" });
		wrapper.createEl("label", { text: label });
		const select = wrapper.createEl("select");
		for (const option of options) {
			const optionEl = select.createEl("option", { text: option.label });
			optionEl.value = option.value;
			optionEl.selected = option.value === currentValue;
		}
		select.onchange = () => onChange(select.value);
	}

	private renderResultList(): void {
		if (!this.listEl) {
			return;
		}

		this.listEl.empty();
		if (!this.analysis) {
			this.listEl.createDiv({ cls: "semantic-auto-linker-loading-block" });
			this.listEl.createEl("p", {
				text: "Reading notes, matching links, and preparing the graph preview...",
				cls: "semantic-auto-linker-empty-state",
			});
			return;
		}
		this.updateControlVisibility();
		if (this.suggestionSortMode !== "document") {
			const flatSuggestions = this.getVisibleSuggestionsFlat();
			this.renderSummary(this.analysis.graphMetrics, flatSuggestions);
			if (flatSuggestions.length === 0) {
				this.listEl.createEl("p", {
					text: "No suggestions match the current filters.",
					cls: "semantic-auto-linker-empty-state",
				});
				return;
			}

			const rows = this.listEl.createDiv({ cls: "semantic-auto-linker-flat-list" });
			for (const entry of flatSuggestions) {
				const row = rows.createDiv({ cls: "semantic-auto-linker-row" });
				row.dataset.suggestionId = entry.suggestion.id;

				const checkbox = row.createEl("input", { type: "checkbox" });
				checkbox.checked = entry.suggestion.accepted;
				checkbox.onchange = () => {
					entry.suggestion.accepted = checkbox.checked;
					this.onChange();
					if (this.analysis) {
						this.graphPanel?.updateAnalysis(this.analysis);
					}
					this.renderResultList();
				};

				const body = row.createDiv({ cls: "semantic-auto-linker-row-body" });
				body.createDiv({
					text: `"${entry.suggestion.matchedText}" -> [[${entry.suggestion.targetTitle}]]`,
					cls: "semantic-auto-linker-row-title",
				});
				body.createDiv({
					text: `${entry.result.file.basename} | ${entry.suggestion.reason} | ${(entry.suggestion.confidence * 100).toFixed(0)}%`,
					cls: "semantic-auto-linker-row-meta",
				});
				const details = body.createEl("details", { cls: "semantic-auto-linker-row-details" });
				details.createEl("summary", { text: "Context" });
				details.createDiv({
					text: entry.suggestion.context,
					cls: "semantic-auto-linker-row-context",
				});
			}
			return;
		}
		const groups = this.getVisibleGroups();
		this.renderSummary(this.analysis.graphMetrics, groups);

		if (groups.length === 0) {
			this.listEl.createEl("p", {
				text: "No suggestions match the current filters.",
				cls: "semantic-auto-linker-empty-state",
			});
			return;
		}

		for (const group of groups) {
			const section = this.listEl.createEl("details", { cls: "semantic-auto-linker-group" });
			section.open = this.expandedGroups.has(group.result.file.path);
			section.ontoggle = () => {
				if (section.open) {
					this.expandedGroups.add(group.result.file.path);
				} else {
					this.expandedGroups.delete(group.result.file.path);
				}
			};

			const summary = section.createEl("summary", { cls: "semantic-auto-linker-group-summary" });
			summary.createSpan({ text: `${group.result.file.basename} (${group.suggestions.length}/${group.result.suggestions.length})` });
			const acceptedCount = group.suggestions.filter((suggestion) => suggestion.accepted).length;
			summary.createSpan({
				text: `${acceptedCount} accepted · top ${(group.topConfidence * 100).toFixed(0)}%`,
				cls: "semantic-auto-linker-group-meta",
			});

			const rows = section.createDiv({ cls: "semantic-auto-linker-group-rows" });
			for (const suggestion of group.suggestions) {
				const row = rows.createDiv({ cls: "semantic-auto-linker-row" });
				row.dataset.suggestionId = suggestion.id;

				const checkbox = row.createEl("input", { type: "checkbox" });
				checkbox.checked = suggestion.accepted;
				checkbox.onchange = () => {
					suggestion.accepted = checkbox.checked;
					this.onChange();
					if (this.analysis) {
						this.graphPanel?.updateAnalysis(this.analysis);
					}
					this.renderResultList();
				};

				const body = row.createDiv({ cls: "semantic-auto-linker-row-body" });
				body.createDiv({
					text: `"${suggestion.matchedText}" -> [[${suggestion.targetTitle}]]`,
					cls: "semantic-auto-linker-row-title",
				});
				body.createDiv({
					text: `${suggestion.reason} | ${(suggestion.confidence * 100).toFixed(0)}%`,
					cls: "semantic-auto-linker-row-meta",
				});
				const details = body.createEl("details", { cls: "semantic-auto-linker-row-details" });
				details.createEl("summary", { text: "Context" });
				details.createDiv({
					text: suggestion.context,
					cls: "semantic-auto-linker-row-context",
				});
			}
		}
	}

	private getVisibleGroups(): Array<{ result: AnalysisResult; suggestions: LinkSuggestion[]; topConfidence: number; lowConfidence: number }> {
		if (!this.analysis) {
			return [];
		}
		const groups = this.analysis.results
			.map((result) => {
				const suggestions = result.suggestions
					.filter((suggestion) => this.matchesFilter(suggestion))
					.sort((left, right) => this.compareSuggestions(left, right));
				return {
					result,
					suggestions,
					topConfidence: suggestions[0]?.confidence ?? 0,
					lowConfidence: suggestions.reduce((lowest, suggestion) => Math.min(lowest, suggestion.confidence), Number.POSITIVE_INFINITY),
				};
			})
			.filter((group) => group.suggestions.length > 0);

		groups.sort((left, right) => {
			if (this.groupSortMode === "name") {
				if (this.suggestionSortMode === "highest-confidence") {
					return right.topConfidence - left.topConfidence || left.result.file.basename.localeCompare(right.result.file.basename);
				}
				if (this.suggestionSortMode === "lowest-confidence") {
					return left.lowConfidence - right.lowConfidence || left.result.file.basename.localeCompare(right.result.file.basename);
				}
			}

			switch (this.groupSortMode) {
				case "most-suggestions":
					return right.suggestions.length - left.suggestions.length || left.result.file.basename.localeCompare(right.result.file.basename);
				case "highest-confidence":
					return right.topConfidence - left.topConfidence || left.result.file.basename.localeCompare(right.result.file.basename);
				case "lowest-confidence":
					return left.lowConfidence - right.lowConfidence || left.result.file.basename.localeCompare(right.result.file.basename);
				case "name":
				default:
					return left.result.file.basename.localeCompare(right.result.file.basename);
			}
		});

		return groups;
	}

	private getVisibleSuggestionsFlat(): Array<{ result: AnalysisResult; suggestion: LinkSuggestion }> {
		if (!this.analysis) {
			return [];
		}
		return this.analysis.results
			.flatMap((result) =>
				result.suggestions
					.filter((suggestion) => this.matchesFilter(suggestion))
					.map((suggestion) => ({ result, suggestion })),
			)
			.sort((left, right) =>
				this.compareSuggestions(left.suggestion, right.suggestion)
				|| left.result.file.basename.localeCompare(right.result.file.basename),
			);
	}

	private matchesFilter(suggestion: LinkSuggestion): boolean {
		switch (this.filterMode) {
			case "semantic":
				return suggestion.matchType === "semantic";
			case "deterministic":
				return suggestion.matchType !== "semantic";
			case "accepted":
				return suggestion.accepted;
			case "unchecked":
				return !suggestion.accepted;
			case "all":
			default:
				return true;
		}
	}

	private compareSuggestions(left: LinkSuggestion, right: LinkSuggestion): number {
		switch (this.suggestionSortMode) {
			case "lowest-confidence":
				return left.confidence - right.confidence || left.start - right.start;
			case "document":
				return left.start - right.start || left.end - right.end;
			case "highest-confidence":
			default:
				return right.confidence - left.confidence || left.start - right.start;
		}
	}

	private renderSummary(
		metrics?: VaultAnalysisResult["graphMetrics"],
		entries: Array<{ result: AnalysisResult; suggestions: LinkSuggestion[] }> | Array<{ result: AnalysisResult; suggestion: LinkSuggestion }> = this.getVisibleGroups(),
	): void {
		if (!this.summaryPrimaryEl || !this.summarySecondaryEl) {
			return;
		}
		if (!this.analysis || !metrics) {
			this.summaryPrimaryEl.setText("Preparing whole-vault analysis...");
			this.summarySecondaryEl.setText("The review modal opens immediately and fills in once note scanning completes.");
			return;
		}
		const normalizedEntries = entries as Array<{ result: AnalysisResult; suggestions?: LinkSuggestion[]; suggestion?: LinkSuggestion }>;
		const visibleSuggestions = normalizedEntries.reduce((total, entry) => total + (entry.suggestions ? entry.suggestions.length : entry.suggestion ? 1 : 0), 0);
		const visibleFiles = new Set(normalizedEntries.map((entry) => entry.result.file.path)).size;
		this.summaryPrimaryEl.setText(
			`${visibleSuggestions} visible suggestion${visibleSuggestions === 1 ? "" : "s"} across ${visibleFiles} visible file${visibleFiles === 1 ? "" : "s"} (${this.analysis.totalSuggestions} accepted total).`,
		);
		this.summarySecondaryEl.setText(
			`${metrics.existingLinkCount} links now -> ${metrics.projectedLinkCount} after apply (${metrics.projectedAddedLinks} added)`,
		);
	}

	updateProgress(progress: VaultAnalysisJobState): void {
		if (!this.progressShellEl || !this.progressFillEl || !this.progressCopyEl) {
			return;
		}

		const active = progress.status === "running" || progress.status === "updating";
		const ratio = progress.total > 0 ? Math.max(0, Math.min(1, progress.current / progress.total)) : 0;
		this.progressShellEl.toggleClass("is-active", active || progress.status === "failed");
		this.progressShellEl.toggleClass("is-error", progress.status === "failed");
		this.progressFillEl.setCssProps({ width: `${Math.round(ratio * 100)}%` });
		if (!active && progress.status !== "failed") {
			this.progressCopyEl.setText(progress.message);
			return;
		}
		const count = progress.total > 0 ? `${Math.min(progress.current, progress.total)}/${progress.total}` : "";
		this.progressCopyEl.setText(count ? `${progress.message} ${count}` : progress.message);
	}

	updateAnalysis(analysis: VaultAnalysisResult): void {
		this.analysis = analysis;
		if (!this.rightPaneEl) {
			return;
		}
		if (!this.graphPanel) {
			if (this.graphHostEl) {
				this.graphHostEl.empty();
				this.graphPanel = new GraphPreviewPanel(this.app, this.graphHostEl, analysis, "after");
			}
		} else {
			this.graphPanel.updateAnalysis(analysis);
		}
		this.renderResultList();
	}

	private updateControlVisibility(): void {
		const showGroups = this.suggestionSortMode === "document";
		if (this.groupSortControlEl) {
			this.groupSortControlEl.setCssProps({ display: showGroups ? "" : "none" });
		}
		if (this.groupButtonsControlEl) {
			this.groupButtonsControlEl.setCssProps({ display: showGroups ? "" : "none" });
		}
	}
}

function applyAcceptanceThreshold(suggestions: LinkSuggestion[], threshold: number): void {
	for (const suggestion of suggestions) {
		suggestion.accepted = suggestion.matchType === "semantic"
			? suggestion.confidence >= threshold
			: true;
	}
}

function createThresholdAcceptMenu(
	containerEl: HTMLElement,
	settings: SemanticAutoLinkerSettings,
	onApply: () => void,
): void {
	const wrapper = containerEl.createDiv({ cls: "semantic-auto-linker-threshold-menu" });
	const toggle = wrapper.createEl("button", {
		text: "⋯",
		cls: "semantic-auto-linker-threshold-toggle",
		attr: { "aria-label": "Threshold accept options" },
	});
	const panel = wrapper.createDiv({ cls: "semantic-auto-linker-threshold-panel" });
	panel.setCssProps({ display: "none" });

	const label = panel.createDiv({
		text: `Accept semantic >= ${(settings.semanticAcceptanceThreshold * 100).toFixed(0)}%`,
		cls: "semantic-auto-linker-threshold-label",
	});
	const slider = panel.createEl("input", {
		type: "range",
		cls: "semantic-auto-linker-threshold-slider",
	});
	slider.min = "40";
	slider.max = "90";
	slider.step = "1";
	slider.value = String(Math.round(settings.semanticAcceptanceThreshold * 100));

	const valueEl = panel.createDiv({
		text: `${Math.round(settings.semanticAcceptanceThreshold * 100)}%`,
		cls: "semantic-auto-linker-threshold-value",
	});
	const applyButton = panel.createEl("button", {
		text: "Accept threshold",
		cls: "semantic-auto-linker-threshold-apply",
	});

	slider.oninput = () => {
		settings.semanticAcceptanceThreshold = Number(slider.value) / 100;
		label.setText(`Accept semantic >= ${slider.value}%`);
		valueEl.setText(`${slider.value}%`);
	};

	applyButton.onclick = () => {
		onApply();
		panel.setCssProps({ display: "none" });
		toggle.removeClass("is-active");
	};

	toggle.onclick = () => {
		const nextOpen = panel.style.display === "none";
		panel.setCssProps({ display: nextOpen ? "flex" : "none" });
		toggle.toggleClass("is-active", nextOpen);
	};
}

function createInsertionModeToggle(
	containerEl: HTMLElement,
	currentMode: ReviewInsertionMode,
	onChange: (mode: ReviewInsertionMode) => void,
): void {
	const shell = containerEl.createDiv({ cls: "semantic-auto-linker-mode-toggle" });
	const inlineButton = shell.createEl("button", { text: "Inline" });
	const footerButton = shell.createEl("button", { text: "Footer" });
	const sync = (mode: ReviewInsertionMode) => {
		inlineButton.toggleClass("is-active", mode === "inline");
		footerButton.toggleClass("is-active", mode === "footer");
	};
	sync(currentMode);
	inlineButton.onclick = () => {
		sync("inline");
		onChange("inline");
	};
	footerButton.onclick = () => {
		sync("footer");
		onChange("footer");
	};
}

function createModeInfo(containerEl: HTMLElement, message: string): void {
	const infoButton = containerEl.createEl("button", {
		cls: "semantic-auto-linker-mode-info",
		attr: {
			type: "button",
			"aria-label": "Insertion mode help",
		},
	});
	infoButton.title = message;
	setIcon(infoButton, "info");
}

export class RelatedNotesModal extends Modal {
	private suggestions: RelatedNoteSuggestion[];
	private noteTitle: string;

	constructor(app: Modal["app"], noteTitle: string, suggestions: RelatedNoteSuggestion[]) {
		super(app);
		this.suggestions = suggestions;
		this.noteTitle = noteTitle;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(`Related notes for ${this.noteTitle}`);
		contentEl.empty();

		if (this.suggestions.length === 0) {
			contentEl.createEl("p", { text: "No related notes found with the current deterministic ranking." });
			return;
		}

		for (const suggestion of this.suggestions) {
			const row = contentEl.createDiv({ cls: "semantic-auto-linker-row" });
			row.createDiv({
				text: `[[${suggestion.targetTitle}]]`,
				cls: "semantic-auto-linker-row-title",
			});
			row.createDiv({
				text: `${suggestion.reason}${suggestion.matchType ? ` | ${suggestion.matchType}` : ""} | score ${suggestion.score}`,
				cls: "semantic-auto-linker-row-meta",
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
