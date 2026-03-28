import { Modal } from "obsidian";
import type { SemanticBuildProgress } from "./types";

export class SemanticBuildProgressModal extends Modal {
	private headingEl!: HTMLHeadingElement;
	private messageEl!: HTMLParagraphElement;
	private countEl!: HTMLDivElement;
	private progressFillEl!: HTMLDivElement;

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("semantic-auto-linker-semantic-progress");

		this.headingEl = contentEl.createEl("h2", { text: "Building semantic index" });
		this.messageEl = contentEl.createEl("p", { text: "Starting semantic build..." });
		this.countEl = contentEl.createDiv({ cls: "semantic-auto-linker-semantic-progress-count" });

		const trackEl = contentEl.createDiv({ cls: "semantic-auto-linker-semantic-progress-track" });
		this.progressFillEl = trackEl.createDiv({ cls: "semantic-auto-linker-semantic-progress-fill" });
	}

	updateProgress(progress: SemanticBuildProgress): void {
		if (!this.headingEl) {
			return;
		}
		this.headingEl.setText(titleForStage(progress.stage));
		this.messageEl.setText(progress.message);
		const total = Math.max(1, progress.total);
		const percent = progress.stage === "complete" ? 100 : Math.round((progress.current / total) * 100);
		this.countEl.setText(`${Math.min(progress.current, progress.total)}/${progress.total}`);
			this.progressFillEl.setCssProps({ width: `${Math.max(0, Math.min(100, percent))}%` });
	}
}

function titleForStage(stage: SemanticBuildProgress["stage"]): string {
	switch (stage) {
		case "checking-provider":
			return "Checking semantic provider";
		case "preparing-notes":
			return "Preparing semantic notes";
		case "embedding":
			return "Generating semantic embeddings";
		case "complete":
			return "Semantic index complete";
		default:
			return "Building semantic index";
	}
}
