import ForceGraph3D, { type ForceGraph3DInstance, type LinkObject, type NodeObject } from "3d-force-graph";
import * as THREE from "three";
import { Modal, Notice, Setting, setIcon, type App } from "obsidian";
import type SemanticAutoLinkerPlugin from "./main";
import type { SemanticProjectionPoint } from "./types";
import type { SemanticIndex } from "./semantic-index";

type ProjectionMode = "pca" | "tsne";
type ProjectionDimensions = 2 | 3;
type ProjectionScope = "notes" | "concepts";
type ColorMode = "semantic" | "location" | "none";

interface ExplorerNode extends NodeObject {
	id: string;
	label: string;
	parentTitle: string;
	kind: "note" | "concept";
	path: string;
	region: string;
	x: number;
	y: number;
	z: number;
	fx: number;
	fy: number;
	fz: number;
	color: string;
	cluster: number;
}

interface ExplorerLink extends LinkObject<ExplorerNode> {
	source: string;
	target: string;
	weight: number;
}

export class EmbeddingExplorerModal extends Modal {
	private plugin: SemanticAutoLinkerPlugin;
	private semanticIndex: SemanticIndex;
	private projectionScope: ProjectionScope = "notes";
	private mode: ProjectionMode = "pca";
	private dimensions: ProjectionDimensions = 3;
	private colorMode: ColorMode = "semantic";
	private graphHostEl: HTMLElement | null = null;
	private labelLayerEl: HTMLElement | null = null;
	private projectionSettingsEl: HTMLDetailsElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private graph: ForceGraph3DInstance<ExplorerNode, ExplorerLink> | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private points: SemanticProjectionPoint[] = [];
	private currentNodes: ExplorerNode[] = [];
	private labelFrame = 0;

	constructor(app: App, plugin: SemanticAutoLinkerPlugin, semanticIndex: SemanticIndex) {
		super(app);
		this.plugin = plugin;
		this.semanticIndex = semanticIndex;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Embedding explorer");
		contentEl.empty();
		contentEl.addClass("semantic-auto-linker-modal");
		contentEl.addClass("semantic-auto-linker-embedding-modal");
		this.modalEl.setCssProps({
			width: "min(1380px, 96vw)",
			maxWidth: "96vw",
			height: "min(920px, 92vh)",
		});

		const toolbar = contentEl.createDiv({ cls: "semantic-auto-linker-embedding-toolbar" });
		this.createSelectControl(toolbar, "Scope", this.projectionScope, [
			{ value: "notes", label: "Notes" },
			{ value: "concepts", label: "Concepts" },
		], async (value) => {
			this.projectionScope = value as ProjectionScope;
			await this.refreshProjection(false);
		});
		this.createSelectControl(toolbar, "Projection", this.mode, [
			{ value: "pca", label: "PCA" },
			{ value: "tsne", label: "t-SNE" },
		], async (value) => {
			this.mode = value as ProjectionMode;
			this.updateProjectionSettingsVisibility();
			await this.refreshProjection(false);
		});
		this.createSelectControl(toolbar, "Dimensions", String(this.dimensions), [
			{ value: "2", label: "2D" },
			{ value: "3", label: "3D" },
		], async (value) => {
			this.dimensions = Number(value) === 3 ? 3 : 2;
			await this.refreshProjection(false);
		});
		this.createSelectControl(toolbar, "Color", this.colorMode, [
			{ value: "semantic", label: "By semantic cluster" },
			{ value: "location", label: "By location" },
			{ value: "none", label: "Neutral" },
		], (value) => {
			this.colorMode = value as ColorMode;
			this.renderGraph();
		});
		const fitButton = toolbar.createEl("button", { text: "Fit view" });
		fitButton.onclick = () => this.fitCloser(300);
		const refreshButton = toolbar.createEl("button", { text: "Refresh projection" });
		refreshButton.onclick = () => void this.refreshProjection(true);
		const info = toolbar.createSpan({ cls: "semantic-auto-linker-graph-info" });
		setIcon(info, "info");
			info.setAttribute("title", "Projection help");

		this.projectionSettingsEl = contentEl.createEl("details", { cls: "semantic-auto-linker-embedding-settings" });
		this.projectionSettingsEl.createEl("summary", { text: "Settings" });
		const settingsBody = this.projectionSettingsEl.createDiv({ cls: "semantic-auto-linker-embedding-settings-body" });
		const metricSetting = new Setting(settingsBody)
			.setName("Metric")
			.setDesc("Cosine normalizes vectors first. Euclidean keeps the raw vector scale.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("cosine", "Cosine")
					.addOption("euclidean", "Euclidean")
					.setValue(this.plugin.settings.semanticProjectionMetric)
					.onChange(async (value) => {
						this.plugin.settings.semanticProjectionMetric = value as SemanticAutoLinkerPlugin["settings"]["semanticProjectionMetric"];
						await this.plugin.saveSettings();
						await this.refreshProjection(false);
					}),
			);
		metricSetting.settingEl.addClass("semantic-auto-linker-embedding-setting-row");

			const perplexitySetting = new Setting(settingsBody)
				.setName("Perplexity")
			.setDesc("Higher values spread attention across a broader local neighborhood.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 40, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticProjectionPerplexity)
					.onChange(async (value) => {
						this.plugin.settings.semanticProjectionPerplexity = value;
						await this.plugin.saveSettings();
						if (this.mode === "tsne") {
							await this.refreshProjection(false);
						}
					}),
			);
		perplexitySetting.settingEl.addClass("semantic-auto-linker-embedding-setting-row");
		perplexitySetting.settingEl.addClass("semantic-auto-linker-embedding-setting-tsne");

			const iterationsSetting = new Setting(settingsBody)
				.setName("Iterations")
			.setDesc("More iterations usually tighten clusters, but take longer.")
			.addSlider((slider) =>
				slider
					.setLimits(200, 1200, 50)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticProjectionIterations)
					.onChange(async (value) => {
						this.plugin.settings.semanticProjectionIterations = value;
						await this.plugin.saveSettings();
						if (this.mode === "tsne") {
							await this.refreshProjection(false);
						}
					}),
			);
		iterationsSetting.settingEl.addClass("semantic-auto-linker-embedding-setting-row");
		iterationsSetting.settingEl.addClass("semantic-auto-linker-embedding-setting-tsne");

		const labelDistanceSetting = new Setting(settingsBody)
			.setName("Label distance")
			.setDesc("Nearest labels within this distance stay visible; farther labels fade out.")
			.addSlider((slider) =>
				slider
					.setLimits(200, 1600, 20)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.semanticExplorerLabelDistance)
					.onChange(async (value) => {
						this.plugin.settings.semanticExplorerLabelDistance = value;
						await this.plugin.saveSettings();
						this.updateLabelPositions();
					}),
			);
		labelDistanceSetting.settingEl.addClass("semantic-auto-linker-embedding-setting-row");

		this.summaryEl = contentEl.createDiv({ cls: "semantic-auto-linker-embedding-summary" });
		this.graphHostEl = contentEl.createDiv({ cls: "semantic-auto-linker-embedding-host" });
		const controlsHint = this.graphHostEl.createDiv({ cls: "semantic-auto-linker-embedding-controls-hint" });
		controlsHint.setText("Drag: rotate  Shift+drag: pan  Scroll: zoom");
		this.updateProjectionSettingsVisibility();
		this.createGraph();
		void this.refreshProjection(false);
	}

	onClose(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.labelFrame) {
			window.cancelAnimationFrame(this.labelFrame);
			this.labelFrame = 0;
		}
		this.graph?._destructor();
		this.graph = null;
		this.labelLayerEl = null;
		this.projectionSettingsEl = null;
		this.currentNodes = [];
		this.contentEl.empty();
		this.modalEl.setCssProps({
			width: "",
			maxWidth: "",
			height: "",
		});
	}

	private createGraph(): void {
		if (!this.graphHostEl) {
			return;
		}

		this.graph = new ForceGraph3D(this.graphHostEl, {
			controlType: "orbit",
		}) as ForceGraph3DInstance<ExplorerNode, ExplorerLink>;
		this.graph
			.backgroundColor("rgba(0,0,0,0)")
			.showNavInfo(false)
			.nodeId("id")
			.nodeLabel((node: ExplorerNode) => this.projectionScope === "notes" ? node.label : `${node.label} | ${node.parentTitle}`)
			.nodeColor((node: ExplorerNode) => node.color)
			.nodeVal(4)
			.nodeThreeObject((node: ExplorerNode) => createNodeObject(node))
			.linkDirectionalParticles((link: ExplorerLink) => link.weight >= 0.72 ? 1 : 0)
			.linkDirectionalParticleWidth(0.8)
			.linkDirectionalParticleSpeed(0.0025)
			.linkColor(() => "rgba(141, 152, 164, 0.28)")
			.linkWidth((link: ExplorerLink) => 0.4 + link.weight * 1.2)
			.linkOpacity(0.4)
			.enableNodeDrag(false)
			.cooldownTicks(0)
			.onNodeClick((node: ExplorerNode) => {
				void this.app.workspace.openLinkText(node.path, "", true);
			});

		this.labelLayerEl = this.graphHostEl.createDiv({ cls: "semantic-auto-linker-embedding-label-layer" });

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.graph || !this.graphHostEl) {
				return;
			}
			this.graph.width(Math.max(480, this.graphHostEl.clientWidth)).height(Math.max(520, this.graphHostEl.clientHeight));
			this.updateLabelPositions();
		});
		this.resizeObserver.observe(this.graphHostEl);
		this.startLabelLoop();
	}

	private async refreshProjection(forceNotice: boolean): Promise<void> {
		try {
			this.points = await this.semanticIndex.buildProjection(this.mode, this.dimensions, this.projectionScope);
			this.renderGraph();
			if (forceNotice) {
				new Notice(`Updated ${this.projectionScope} ${this.mode.toUpperCase()} ${this.dimensions}D embedding view.`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Projection failed";
			if (this.summaryEl) {
				this.summaryEl.empty();
				this.summaryEl.createDiv({ text: `Projection failed: ${message}` });
			}
		}
	}

	private renderGraph(): void {
		if (!this.graph || !this.graphHostEl || !this.summaryEl) {
			return;
		}

		this.summaryEl.empty();
		if (this.points.length === 0) {
			this.summaryEl.createDiv({ text: "No semantic vectors are available for projection yet." });
			this.graph.graphData({ nodes: [], links: [] });
			return;
		}

		const nodes = buildExplorerNodes(this.points, this.colorMode);
		const links = buildNeighborLinks(this.points, 3);
		this.currentNodes = nodes;

		this.graph
			.width(Math.max(480, this.graphHostEl.clientWidth))
			.height(Math.max(520, this.graphHostEl.clientHeight))
			.numDimensions(this.dimensions)
			.graphData({ nodes, links });

		this.summaryEl.createDiv({
			text: `${this.points.length} ${this.projectionScope} projected with ${this.mode.toUpperCase()} in ${this.dimensions}D. Click a node to open the note.`,
			cls: "semantic-auto-linker-embedding-summary-main",
		});
		this.summaryEl.createDiv({ text: `${links.length} neighborhood links` });
		this.summaryEl.createDiv({
			text:
				this.colorMode === "semantic"
					? "Colored by semantic neighborhood cluster"
					: this.colorMode === "location"
						? "Colored by top-level folder"
						: "Neutral node colors",
		});
		this.summaryEl.createDiv({ text: this.mode === "pca" ? "Global structure preserved" : "Local neighborhoods emphasized" });
		if (this.dimensions === 3) {
			renderSeparationMatrixAccordion(this.summaryEl, this.points);
		}
		this.renderLabelLayer();
		window.setTimeout(() => {
			this.fitCloser(300);
			this.updateLabelPositions();
		}, 0);
	}

	private createSelectControl(
		containerEl: HTMLElement,
		label: string,
		currentValue: string,
		options: Array<{ value: string; label: string }>,
		onChange: (value: string) => void | Promise<void>,
	): void {
		const wrapper = containerEl.createDiv({ cls: "semantic-auto-linker-vault-control" });
		wrapper.createEl("label", { text: label });
		const select = wrapper.createEl("select");
		for (const option of options) {
			const optionEl = select.createEl("option", { text: option.label });
			optionEl.value = option.value;
			optionEl.selected = option.value === currentValue;
		}
		select.onchange = () => {
			void onChange(select.value);
		};
	}

	private startLabelLoop(): void {
		if (this.labelFrame) {
			window.cancelAnimationFrame(this.labelFrame);
		}
		const tick = () => {
			this.updateLabelPositions();
			this.labelFrame = window.requestAnimationFrame(tick);
		};
		this.labelFrame = window.requestAnimationFrame(tick);
	}

	private updateProjectionSettingsVisibility(): void {
		if (!this.projectionSettingsEl) {
			return;
		}
		this.projectionSettingsEl.setCssProps({ display: "" });
		const tsneRows = this.projectionSettingsEl.querySelectorAll<HTMLElement>(".semantic-auto-linker-embedding-setting-tsne");
		tsneRows.forEach((row) => {
			row.setCssProps({ display: this.mode === "tsne" ? "" : "none" });
		});
	}

	private fitCloser(durationMs: number): void {
		if (!this.graph) {
			return;
		}
		this.graph.zoomToFit(durationMs, 0);
		window.setTimeout(() => {
			if (!this.graph) {
				return;
			}
			const cameraPosition = this.graph.cameraPosition();
			this.graph.cameraPosition(
				{
					x: (cameraPosition.x ?? 0) * 0.42,
					y: (cameraPosition.y ?? 0) * 0.42,
					z: Math.max(20, (cameraPosition.z ?? 0) * 0.42),
				},
				undefined,
				Math.max(120, durationMs - 80),
			);
		}, Math.max(40, durationMs * 0.35));
	}

	private renderLabelLayer(): void {
		if (!this.labelLayerEl) {
			return;
		}
		this.labelLayerEl.empty();
		for (const node of this.currentNodes) {
			const labelEl = this.labelLayerEl.createDiv({ cls: "semantic-auto-linker-embedding-label" });
			labelEl.dataset.nodeId = node.id;
			labelEl.setText(this.projectionScope === "notes" ? node.label : `${node.label} | ${node.parentTitle}`);
			labelEl.setAttribute("title", this.projectionScope === "notes" ? node.label : `${node.label} · ${node.parentTitle}`);
		}
		this.updateLabelPositions();
	}

	private updateLabelPositions(): void {
		if (!this.graph || !this.graphHostEl || !this.labelLayerEl) {
			return;
		}
		const graphNodes = this.graph.graphData().nodes as ExplorerNode[] | undefined;
		const positionedNodes = graphNodes?.length ? graphNodes : this.currentNodes;
		if (positionedNodes.length === 0) {
			return;
		}
		const width = this.graphHostEl.clientWidth;
		const height = this.graphHostEl.clientHeight;
		const cameraPosition = this.graph.cameraPosition();
		const labelDistance = this.plugin.settings.semanticExplorerLabelDistance;
		const visibleNodeIds = new Set(
			positionedNodes
				.map((node) => ({
					id: node.id,
					distance: Math.sqrt(
						((node.x ?? 0) - (cameraPosition.x ?? 0)) ** 2 +
						((node.y ?? 0) - (cameraPosition.y ?? 0)) ** 2 +
						((node.z ?? 0) - (cameraPosition.z ?? 0)) ** 2,
					),
				}))
				.filter((entry) => entry.distance <= labelDistance * 1.15)
				.sort((left, right) => left.distance - right.distance)
				.map((entry) => entry.id),
		);
		const labels = Array.from(this.labelLayerEl.querySelectorAll<HTMLElement>(".semantic-auto-linker-embedding-label"));
		for (const labelEl of labels) {
			const nodeId = labelEl.dataset.nodeId;
			const node = nodeId ? positionedNodes.find((entry) => entry.id === nodeId) : null;
			if (!node) {
					labelEl.setCssProps({ opacity: "0" });
				continue;
			}
			const nodeDistance = Math.sqrt(
				((node.x ?? 0) - (cameraPosition.x ?? 0)) ** 2 +
				((node.y ?? 0) - (cameraPosition.y ?? 0)) ** 2 +
				((node.z ?? 0) - (cameraPosition.z ?? 0)) ** 2,
			);
			if (!visibleNodeIds.has(node.id)) {
					labelEl.setCssProps({ opacity: "0" });
				continue;
			}
			const coords = this.graph.graph2ScreenCoords(node.x ?? 0, (node.y ?? 0) + 6, node.z ?? 0);
			const visible = Number.isFinite(coords.x)
				&& Number.isFinite(coords.y)
				&& coords.x >= 0
				&& coords.x <= width
				&& coords.y >= 0
				&& coords.y <= height;
			if (!visible) {
					labelEl.setCssProps({ opacity: "0" });
				continue;
			}
			const normalizedDistance = Math.min(1.2, nodeDistance / Math.max(1, labelDistance));
			const opacity = Math.max(0.18, 1.08 - normalizedDistance);
			const scale = Math.max(0.62, 1.04 - (normalizedDistance * 0.34));
				labelEl.setCssProps({ opacity: opacity.toFixed(3) });
			labelEl.style.transform = `translate(${coords.x}px, ${coords.y - 14}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
		}
	}
}

function buildExplorerNodes(points: SemanticProjectionPoint[], colorMode: ColorMode): ExplorerNode[] {
	const clusters = clusterProjection(points, Math.min(8, Math.max(3, Math.round(Math.sqrt(points.length / 2)))));
	return points.map((point, index) => {
		const x = point.x * 180;
		const y = point.y * 180;
		const z = point.z * 180;
		const cluster = clusters[index] ?? 0;
		return {
			id: point.id,
			label: point.title,
			parentTitle: point.parentTitle,
			kind: point.kind,
			path: point.path,
			region: point.region,
			x,
			y,
			z,
			fx: x,
			fy: y,
			fz: z,
			cluster,
			color:
				colorMode === "semantic"
					? colorForCluster(cluster)
					: colorMode === "location"
						? colorForRegion(point.region)
						: "rgba(244, 247, 250, 0.96)",
		};
	});
}

function buildNeighborLinks(points: SemanticProjectionPoint[], neighborCount: number): ExplorerLink[] {
	const links = new Map<string, ExplorerLink>();

	for (let index = 0; index < points.length; index += 1) {
		const point = points[index];
		if (!point) {
			continue;
		}
		const nearest = points
			.map((candidate, candidateIndex) => ({
				candidate,
				candidateIndex,
				distance: candidateIndex === index ? Number.POSITIVE_INFINITY : distanceBetween(point, candidate),
			}))
			.filter((entry) => Number.isFinite(entry.distance))
			.sort((left, right) => left.distance - right.distance)
			.slice(0, neighborCount);

		for (const entry of nearest) {
			const source = point.id;
			const target = entry.candidate.id;
			const edgeId = [source, target].sort().join("::");
			if (!links.has(edgeId)) {
				links.set(edgeId, {
					source,
					target,
					weight: 1 / (1 + entry.distance),
				});
			}
		}
	}

	return [...links.values()];
}

function distanceBetween(left: SemanticProjectionPoint, right: SemanticProjectionPoint): number {
	const dx = left.x - right.x;
	const dy = left.y - right.y;
	const dz = left.z - right.z;
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function colorForRegion(region: string): string {
	const palette = [
		"#9be9a8",
		"#7ee787",
		"#79c0ff",
		"#a5d6ff",
		"#f2cc60",
		"#ffa657",
		"#d2a8ff",
		"#ffb3c1",
		"#8ddbff",
		"#b6e3a1",
	];
	let hash = 0;
	for (let index = 0; index < region.length; index += 1) {
		hash = (hash * 31 + region.charCodeAt(index)) >>> 0;
	}
	return palette[hash % palette.length] ?? "#9be9a8";
}

function colorForCluster(cluster: number): string {
	const palette = [
		"#7ee787",
		"#79c0ff",
		"#f2cc60",
		"#ffa657",
		"#d2a8ff",
		"#ffb3c1",
		"#8ddbff",
		"#b6e3a1",
	];
	return palette[Math.abs(cluster) % palette.length] ?? "#7ee787";
}

function createNodeObject(node: ExplorerNode): THREE.Object3D {
	return new THREE.Mesh(
		new THREE.SphereGeometry(3.2, 16, 16),
		new THREE.MeshBasicMaterial({ color: node.color }),
	);
}

function renderSeparationMatrixAccordion(containerEl: HTMLElement, points: SemanticProjectionPoint[]): void {
	const grouped = new Map<string, SemanticProjectionPoint[]>();
	for (const point of points) {
		if (!grouped.has(point.region)) {
			grouped.set(point.region, []);
		}
		grouped.get(point.region)?.push(point);
	}

	const regions = [...grouped.entries()]
		.filter(([, entries]) => entries.length >= 2)
		.map(([region]) => region)
		.sort((left, right) => left.localeCompare(right))
		.slice(0, 8);
	if (regions.length < 2) {
		return;
	}

	const centroids = new Map<string, { x: number; y: number; z: number }>();
	for (const region of regions) {
		const entries = grouped.get(region) ?? [];
		centroids.set(region, {
			x: entries.reduce((sum, point) => sum + point.x, 0) / entries.length,
			y: entries.reduce((sum, point) => sum + point.y, 0) / entries.length,
			z: entries.reduce((sum, point) => sum + point.z, 0) / entries.length,
		});
	}

	const distances: number[] = [];
	for (let rowIndex = 0; rowIndex < regions.length; rowIndex += 1) {
		for (let columnIndex = rowIndex + 1; columnIndex < regions.length; columnIndex += 1) {
			const left = centroids.get(regions[rowIndex] ?? "");
			const right = centroids.get(regions[columnIndex] ?? "");
			if (!left || !right) {
				continue;
			}
			distances.push(Math.sqrt(
				(left.x - right.x) ** 2 +
				(left.y - right.y) ** 2 +
				(left.z - right.z) ** 2,
			));
		}
	}
	const minDistance = distances.length > 0 ? Math.min(...distances) : 0;
	const maxDistance = distances.length > 0 ? Math.max(...distances) : 1;

	const wrapper = containerEl.createEl("details", { cls: "semantic-auto-linker-embedding-matrix" });
	wrapper.createEl("summary", {
			text: "Cluster matrix",
		cls: "semantic-auto-linker-embedding-matrix-title",
	});
	const matrixBody = wrapper.createDiv({ cls: "semantic-auto-linker-embedding-matrix-body" });
	const table = matrixBody.createEl("table");
	const headRow = table.createTHead().insertRow();
	headRow.createEl("th");
	for (const region of regions) {
		const cell = headRow.createEl("th");
		cell.textContent = truncateLabel(region, 10);
	}

	const body = table.createTBody();
	for (const rowRegion of regions) {
		const row = body.insertRow();
		const labelCell = row.createEl("th");
		labelCell.textContent = truncateLabel(rowRegion, 10);
		for (const columnRegion of regions) {
			const cell = row.insertCell();
			if (rowRegion === columnRegion) {
				cell.textContent = "—";
				cell.className = "is-diagonal";
				continue;
			}
			const left = centroids.get(rowRegion);
			const right = centroids.get(columnRegion);
			const value = !left || !right ? 0 : Math.sqrt(
				(left.x - right.x) ** 2 +
				(left.y - right.y) ** 2 +
				(left.z - right.z) ** 2
			);
			cell.textContent = value.toFixed(2);
			const normalized = maxDistance <= minDistance ? 0.5 : (value - minDistance) / (maxDistance - minDistance);
				cell.setCssProps({
					backgroundColor: separationHeatColor(normalized),
					color: normalized > 0.62 ? "rgba(255, 255, 255, 0.96)" : "var(--text-normal)",
				});
		}
	}
}

function truncateLabel(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function separationHeatColor(normalized: number): string {
	const clamped = Math.min(1, Math.max(0, normalized));
	const red = Math.round(208 - clamped * 114);
	const green = Math.round(59 + clamped * 102);
	const blue = Math.round(72 + clamped * 44);
	const alpha = 0.18 + clamped * 0.38;
	return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}

function clusterProjection(points: SemanticProjectionPoint[], clusterCount: number): number[] {
	if (points.length === 0) {
		return [];
	}
	if (points.length <= clusterCount) {
		return points.map((_, index) => index);
	}

	const centroids = points.slice(0, clusterCount).map((point) => [point.x, point.y, point.z]);
	const assignments = new Array<number>(points.length).fill(0);

	for (let iteration = 0; iteration < 8; iteration += 1) {
		for (let index = 0; index < points.length; index += 1) {
			const point = points[index];
			let bestCluster = 0;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex += 1) {
				const centroid = centroids[centroidIndex];
				if (!centroid || !point) {
					continue;
				}
				const distance = squaredDistance3(point.x, point.y, point.z, centroid[0] ?? 0, centroid[1] ?? 0, centroid[2] ?? 0);
				if (distance < bestDistance) {
					bestDistance = distance;
					bestCluster = centroidIndex;
				}
			}
			assignments[index] = bestCluster;
		}

		for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex += 1) {
			let count = 0;
			let totalX = 0;
			let totalY = 0;
			let totalZ = 0;
			for (let index = 0; index < points.length; index += 1) {
				if (assignments[index] !== centroidIndex) {
					continue;
				}
				const point = points[index];
				if (!point) {
					continue;
				}
				totalX += point.x;
				totalY += point.y;
				totalZ += point.z;
				count += 1;
			}
			if (count > 0) {
				centroids[centroidIndex] = [totalX / count, totalY / count, totalZ / count];
			}
		}
	}

	return assignments;
}

function squaredDistance3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
	const dx = ax - bx;
	const dy = ay - by;
	const dz = az - bz;
	return dx * dx + dy * dy + dz * dz;
}
