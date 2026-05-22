import { App, DropdownComponent, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type SemanticAutoLinkerPlugin from "./main";
import type { SemanticAutoLinkerSettings, SemanticProviderModel } from "./types";
import { formatMultilineSetting, splitMultilineSetting } from "./text-utils";

export const DEFAULT_SETTINGS: SemanticAutoLinkerSettings = {
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
	semanticOllamaBaseUrl: "http://127.0.0.1:11434",
	semanticOllamaModel: "embeddinggemma",
	semanticProjectionMetric: "cosine",
	semanticExplorerLabelDistance: 620,
	semanticDisplayThreshold: 0.3,
	semanticAcceptanceThreshold: 0.6,
	autoRefreshEnabled: true,
	autoRefreshMinutes: 60,
};

export class SemanticAutoLinkerSettingTab extends PluginSettingTab {
	plugin: SemanticAutoLinkerPlugin;

	constructor(app: App, plugin: SemanticAutoLinkerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Linking").setHeading();

		new Setting(containerEl)
			.setName("First occurrence only")
			.setDesc("Only insert the first suggested link for each target note in a note.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.firstOccurrenceOnly).onChange(async (value) => {
					this.plugin.settings.firstOccurrenceOnly = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Max links per note")
			.setDesc("Hard cap for applied suggestions in a single note.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 50, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.maxLinksPerNote)
					.onChange(async (value) => {
						this.plugin.settings.maxLinksPerNote = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Alias matching")
			.setDesc("Allow frontmatter aliases to generate suggestions.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableAliasMatching).onChange(async (value) => {
					this.plugin.settings.enableAliasMatching = value;
					await this.plugin.saveSettings();
					await this.plugin.rebuildIndex("Updated alias matching");
				}),
			);

		new Setting(containerEl)
			.setName("Skip headings")
			.setDesc("Do not suggest links inside Markdown headings.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.skipHeadings).onChange(async (value) => {
					this.plugin.settings.skipHeadings = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("Comma or newline separated paths to skip during indexing and analysis.")
				.addTextArea((text) =>
					text
						.setValue(formatMultilineSetting(this.plugin.settings.excludedFolders))
						.onChange(async (value) => {
						this.plugin.settings.excludedFolders = splitMultilineSetting(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Excluded files")
			.setDesc("Comma or newline separated file paths to skip.")
			.addTextArea((text) =>
				text
					.setPlaceholder("Daily/2026-03-22.md")
					.setValue(formatMultilineSetting(this.plugin.settings.excludedFiles))
					.onChange(async (value) => {
						this.plugin.settings.excludedFiles = splitMultilineSetting(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
				.setName("Footer heading")
				.setDesc("Heading text used when accepted suggestions are inserted into the footer.")
			.addText((text) =>
				text.setValue(this.plugin.settings.seeAlsoHeading).onChange(async (value) => {
					this.plugin.settings.seeAlsoHeading = value.trim() || DEFAULT_SETTINGS.seeAlsoHeading;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
				.setName("Footer suggestions")
				.setDesc("Maximum accepted suggestions to include when using footer insertion.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 12, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.seeAlsoCount)
					.onChange(async (value) => {
						this.plugin.settings.seeAlsoCount = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Semantic mode")
			.setDesc("Enable semantic infrastructure and semantic index rebuild commands.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.semanticMode).onChange(async (value) => {
					this.plugin.settings.semanticMode = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Semantic provider")
			.setDesc("Embedding backend used for the semantic note index.")
			.addDropdown((dropdown) => {
				for (const provider of this.plugin.getSemanticProviders()) {
					dropdown.addOption(provider.id, provider.label);
				}
				dropdown.setValue(this.plugin.settings.semanticProviderId).onChange(async (value) => {
					this.plugin.settings.semanticProviderId = value;
					await this.plugin.saveSettings();
					await this.displayLiveSemanticModels(liveModelDropdown, liveModelStatusEl);
				});
			});

		new Setting(containerEl)
				.setName("Semantic top k")
			.setDesc("Planned number of semantic candidates to retrieve per query span.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticTopK)
					.onChange(async (value) => {
						this.plugin.settings.semanticTopK = value;
						await this.plugin.saveSettings();
					}),
			);

		const liveModelSetting = new Setting(containerEl)
			.setName("Live provider models")
			.setDesc("Refresh and pick from embedding models currently available for the selected semantic provider.");
		let liveModelDropdown: DropdownComponent | null = null;
		let configuredModelText: TextComponent | null = null;
		const liveModelStatusEl = liveModelSetting.descEl.createDiv({ cls: "semantic-auto-linker-setting-hint" });

		liveModelSetting
			.addDropdown((dropdown) => {
				liveModelDropdown = dropdown;
				dropdown.addOption("", "Refresh to load models");
				dropdown.setDisabled(true);
				dropdown.onChange(async (value) => {
					if (!value) {
						return;
					}
					this.plugin.settings.semanticOllamaModel = value;
					configuredModelText?.setValue(value);
					await this.plugin.saveSettings();
				});
			})
			.addButton((button) =>
				button.setButtonText("Refresh").onClick(async () => {
					await this.displayLiveSemanticModels(liveModelDropdown, liveModelStatusEl);
				}),
			);

		new Setting(containerEl)
				.setName("Local endpoint")
				.setDesc("Use this local server for semantic embeddings.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.semanticOllamaBaseUrl)
					.setValue(this.plugin.settings.semanticOllamaBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.semanticOllamaBaseUrl = value.trim() || DEFAULT_SETTINGS.semanticOllamaBaseUrl;
						await this.plugin.saveSettings();
						await this.displayLiveSemanticModels(liveModelDropdown, liveModelStatusEl);
					}),
			);

		new Setting(containerEl)
			.setName("Configured provider model")
			.setDesc("Manual model override used for embedding requests. Pick from the live list above or enter a custom model name.")
			.addText((text) => {
				configuredModelText = text;
				return text
					.setPlaceholder(DEFAULT_SETTINGS.semanticOllamaModel)
					.setValue(this.plugin.settings.semanticOllamaModel)
					.onChange(async (value) => {
						this.plugin.settings.semanticOllamaModel = value.trim() || DEFAULT_SETTINGS.semanticOllamaModel;
						await this.plugin.saveSettings();
						populateLiveModelDropdown(liveModelDropdown, [], this.plugin.settings.semanticOllamaModel);
					});
			});

		new Setting(containerEl)
			.setName("Semantic summary length")
			.setDesc("Maximum summary length per note used for semantic indexing.")
			.addSlider((slider) =>
				slider
					.setLimits(120, 800, 20)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticSummaryLength)
					.onChange(async (value) => {
						this.plugin.settings.semanticSummaryLength = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Projection metric")
			.setDesc("Distance basis used for semantic projection views. Cosine normalizes vectors before projection.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("cosine", "Cosine")
					.addOption("euclidean", "Euclidean")
					.setValue(this.plugin.settings.semanticProjectionMetric)
					.onChange(async (value) => {
						this.plugin.settings.semanticProjectionMetric = value as SemanticAutoLinkerSettings["semanticProjectionMetric"];
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Explorer label distance")
			.setDesc("Show persistent embedding-explorer labels only when the camera is this close or closer.")
			.addSlider((slider) =>
				slider
					.setLimits(200, 1600, 20)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticExplorerLabelDistance)
					.onChange(async (value) => {
						this.plugin.settings.semanticExplorerLabelDistance = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Semantic display threshold")
			.setDesc("Minimum confidence needed to show a semantic suggestion in review.")
			.addSlider((slider) =>
				slider
					.setLimits(0.2, 0.8, 0.01)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticDisplayThreshold)
					.onChange(async (value) => {
						this.plugin.settings.semanticDisplayThreshold = Number(value.toFixed(2));
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Semantic acceptance threshold")
			.setDesc("Default confidence threshold used for pre-accepting semantic suggestions.")
			.addSlider((slider) =>
				slider
					.setLimits(0.4, 0.9, 0.01)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticAcceptanceThreshold)
					.onChange(async (value) => {
						this.plugin.settings.semanticAcceptanceThreshold = Number(value.toFixed(2));
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto refresh indexing and embeddings")
			.setDesc("Periodically rebuild note metadata and semantic embeddings when the vault has changed.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoRefreshEnabled).onChange(async (value) => {
					this.plugin.settings.autoRefreshEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Auto refresh interval")
			.setDesc("How often the plugin checks for changed notes and rebuilds indexes.")
			.addSlider((slider) =>
				slider
					.setLimits(15, 240, 15)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.autoRefreshMinutes)
					.onChange(async (value) => {
						this.plugin.settings.autoRefreshMinutes = value;
						await this.plugin.saveSettings();
					}),
			);

		void this.displayLiveSemanticModels(liveModelDropdown, liveModelStatusEl);
	}

	private async displayLiveSemanticModels(
		dropdown: DropdownComponent | null,
		statusEl: HTMLDivElement | null,
	): Promise<void> {
		if (!dropdown || !statusEl) {
			return;
		}
		const providerId = this.plugin.settings.semanticProviderId;
		const configuredModel = this.plugin.settings.semanticOllamaModel.trim();
		dropdown.selectEl.empty();
		dropdown.addOption("", "Loading models...");
		dropdown.setValue("");
		dropdown.setDisabled(true);
		statusEl.setText("Loading live semantic models...");

		try {
			const models = await this.plugin.getSemanticProviderModels(providerId);
			populateLiveModelDropdown(dropdown, models, configuredModel);
			if (models.length === 0) {
				statusEl.setText("No live embedding models detected for the selected provider.");
			} else {
				statusEl.setText(`Detected ${models.length} live embedding model${models.length === 1 ? "" : "s"}.`);
			}
		} catch (error) {
			populateLiveModelDropdown(dropdown, [], configuredModel);
			const message = error instanceof Error ? error.message : "Unknown model discovery error";
			statusEl.setText(`Could not load provider models: ${message}`);
		}
	}
}

function populateLiveModelDropdown(
	dropdown: DropdownComponent | null,
	models: SemanticProviderModel[],
	configuredModel: string,
): void {
	if (!dropdown) {
		return;
	}
	dropdown.selectEl.empty();
	const seen = new Set<string>();
	if (configuredModel) {
		dropdown.addOption(configuredModel, `Configured: ${configuredModel}`);
		seen.add(configuredModel);
	}
	for (const model of models) {
		if (seen.has(model.id)) {
			continue;
		}
		dropdown.addOption(model.id, model.label);
		seen.add(model.id);
	}
	if (seen.size === 0) {
		dropdown.addOption("", "No models detected");
		dropdown.setValue("");
		dropdown.setDisabled(true);
		return;
	}
	dropdown.setValue(configuredModel || models[0]?.id || "");
	dropdown.setDisabled(false);
}
