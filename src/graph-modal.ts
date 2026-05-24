import ForceGraph, { type LinkObject, type NodeObject } from "force-graph";
import * as d3Force3d from "d3-force-3d";
import { Modal, setIcon, type App } from "obsidian";
import type { GraphEdge, GraphNode, VaultAnalysisResult } from "./types";

type GraphMode = "before" | "after";

interface ForceNode extends NodeObject {
	id: string;
	label: string;
	degreeBefore: number;
	degreeAfter: number;
	growth: boolean;
	community: number;
}

interface ForceLink extends LinkObject<ForceNode> {
	source: string;
	target: string;
	projected: boolean;
	id: string;
}

interface GraphRefreshOptions {
	preserveLayout: boolean;
	refit: boolean;
}

export class GraphPreviewPanel {
	private app: App;
	private containerEl: HTMLElement;
	private analysis: VaultAnalysisResult;
	private mode: GraphMode;
	private graph: ForceGraph<ForceNode, ForceLink> | null = null;
	private graphHostEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private statsEl: HTMLElement | null = null;
	private topListEl: HTMLElement | null = null;
	private detailsEl: HTMLDetailsElement | null = null;
	private beforeButtonEl: HTMLButtonElement | null = null;
	private afterButtonEl: HTMLButtonElement | null = null;
	private fitOnNextEngineStop = false;

	constructor(app: App, containerEl: HTMLElement, analysis: VaultAnalysisResult, initialMode: GraphMode = "after") {
		this.app = app;
		this.containerEl = containerEl;
		this.analysis = analysis;
		this.mode = initialMode;
		this.render();
	}

	updateAnalysis(analysis: VaultAnalysisResult, options: { refit?: boolean } = {}): void {
		this.analysis = analysis;
		if (this.graph) {
			this.refreshGraphData({ preserveLayout: true, refit: options.refit ?? false });
		}
	}

	destroy(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.graph?._destructor();
		this.graph = null;
		this.detailsEl = null;
		this.containerEl.empty();
	}

	private render(): void {
		this.containerEl.empty();
		this.containerEl.addClass("semantic-auto-linker-graph-shell");

		const toolbar = this.containerEl.createDiv({ cls: "semantic-auto-linker-graph-toolbar" });
		this.beforeButtonEl = createModeButton(toolbar, "Before", () => {
			this.mode = "before";
			this.refreshGraphData({ preserveLayout: true, refit: false });
		});
		this.afterButtonEl = createModeButton(toolbar, "After", () => {
			this.mode = "after";
			this.refreshGraphData({ preserveLayout: true, refit: false });
		});
		const fitButton = toolbar.createEl("button", { text: "Fit graph" });
		fitButton.onclick = () => this.fitGraph(220);
		const info = toolbar.createSpan({ cls: "semantic-auto-linker-graph-info" });
		setIcon(info, "info");
		info.setAttribute("title", "After keeps existing links and overlays newly accepted links.");
		info.setAttribute("aria-label", "After keeps existing links and overlays newly accepted links.");

		this.graphHostEl = this.containerEl.createDiv({ cls: "semantic-auto-linker-force-host" });
		this.detailsEl = this.containerEl.createEl("details", { cls: "semantic-auto-linker-graph-details" });
		this.detailsEl.createEl("summary", { text: "Graph details" });
		const detailsBody = this.detailsEl.createDiv({ cls: "semantic-auto-linker-graph-details-body" });
		this.statsEl = detailsBody.createDiv({ cls: "semantic-auto-linker-graph-summary" });
		this.topListEl = detailsBody.createDiv({ cls: "semantic-auto-linker-graph-toplist" });

		this.createGraphInstance();
		this.refreshGraphData({ preserveLayout: false, refit: true });
	}

	private createGraphInstance(): void {
		if (!this.graphHostEl) {
			return;
		}

		this.graph = new ForceGraph<ForceNode, ForceLink>(this.graphHostEl)
			.backgroundColor("rgba(0,0,0,0)")
			.nodeId("id")
			.nodeLabel((node) => `${node.label}\nNow: ${node.degreeBefore} | After: ${node.degreeAfter}`)
			.nodeVal((node) => 0.18 + Math.min(1.1, Math.max(node.degreeBefore, node.degreeAfter) * 0.08))
			.nodeColor((node) => {
				if (node.growth && this.mode === "after") {
					return "rgb(247, 250, 252)";
				}
				return "rgb(188, 196, 204)";
			})
			.linkColor((link) => {
				if (this.mode === "after" && link.projected) {
					return "rgba(63, 185, 80, 0.92)";
				}
				return "rgba(170, 178, 188, 0.42)";
			})
			.linkWidth((link) => (this.mode === "after" && link.projected ? 1.35 : 0.75))
			.linkDirectionalParticles((link) => (this.mode === "after" && link.projected ? 1 : 0))
			.linkDirectionalParticleWidth(1.2)
			.linkDirectionalParticleSpeed(0.004)
			.warmupTicks(18)
			.cooldownTicks(170)
			.d3VelocityDecay(0.24)
			.d3AlphaDecay(0.027)
			.onNodeClick((node) => {
				void this.app.workspace.openLinkText(node.id, "", true);
			})
			.nodeCanvasObject((node, ctx, globalScale) => {
				drawNodeLabel(node, ctx, globalScale);
			})
			.nodeCanvasObjectMode(() => "after")
			.onEngineStop(() => {
				if (!this.fitOnNextEngineStop) {
					return;
				}
				this.fitOnNextEngineStop = false;
				this.fitGraph(180);
			});

		this.graph
			.d3Force("center", d3Force3d.forceCenter(0, 0) as never)
			.d3Force("charge", d3Force3d.forceManyBody().strength(-92) as never)
			.d3Force("collision", createCollideForce((node) => 8 + Math.min(18, getNodeDegree(node) * 1.4)) as never)
			.d3Force("radial", d3Force3d.forceRadial(150, 0, 0).strength(0.018) as never)
			.d3Force("community", createCommunityForce() as never);

		const linkForce = this.graph.d3Force("link") as { distance?: (distance: number) => void; strength?: (strength: number) => void } | undefined;
		linkForce?.distance?.(96);
		linkForce?.strength?.(0.12);

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.graphHostEl || !this.graph) {
				return;
			}
			this.graph
				.width(Math.max(320, this.graphHostEl.clientWidth))
				.height(Math.max(360, this.graphHostEl.clientHeight));
			this.fitGraph(0);
		});
		this.resizeObserver.observe(this.graphHostEl);
	}

	private refreshGraphData(options: GraphRefreshOptions): void {
		if (!this.graph || !this.graphHostEl || !this.statsEl || !this.topListEl) {
			return;
		}

		this.beforeButtonEl?.toggleClass("is-active", this.mode === "before");
		this.afterButtonEl?.toggleClass("is-active", this.mode === "after");

		const positionCache = options.preserveLayout
			? getNodePositions(this.graph.graphData().nodes)
			: new Map<string, ForceNode>();

	const data = buildForceGraphData(
			this.analysis.graphPreview.nodes,
			this.mode === "before" ? this.analysis.graphPreview.edgesBefore : this.analysis.graphPreview.edgesAfter,
			positionCache,
		);

		this.graph
			.width(Math.max(320, this.graphHostEl.clientWidth))
			.height(Math.max(360, this.graphHostEl.clientHeight))
			.graphData(data);

		if (!options.preserveLayout) {
			this.fitOnNextEngineStop = options.refit;
			this.graph.d3ReheatSimulation();
		}

		renderStats(this.statsEl, this.analysis, this.mode, data.links.length);
		renderTopList(this.topListEl, this.analysis.graphPreview.nodes, this.mode);
		if (options.refit && options.preserveLayout) {
			window.setTimeout(() => this.fitGraph(180), 0);
		}
	}

	private fitGraph(durationMs: number): void {
		this.graph?.zoomToFit(durationMs, 28);
	}
}

export class GraphPreviewModal extends Modal {
	private analysis: VaultAnalysisResult;
	private onClosed: () => void;
	private panel: GraphPreviewPanel | null = null;

	constructor(app: Modal["app"], analysis: VaultAnalysisResult, onClosed: () => void) {
		super(app);
		this.analysis = analysis;
		this.onClosed = onClosed;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Graph preview");
		contentEl.empty();
		contentEl.addClass("semantic-auto-linker-graph-modal");
			this.modalEl.setCssProps({
				width: "min(1380px, 96vw)",
				maxWidth: "96vw",
			});
		const panelHost = contentEl.createDiv();
		this.panel = new GraphPreviewPanel(this.app, panelHost, this.analysis, "after");
	}

	onClose(): void {
		this.panel?.destroy();
		this.panel = null;
		this.contentEl.empty();
		this.modalEl.setCssProps({
			width: "",
			maxWidth: "",
		});
		this.onClosed();
	}

	updateAnalysis(analysis: VaultAnalysisResult): void {
		this.analysis = analysis;
		this.panel?.updateAnalysis(analysis);
	}
}

function buildForceGraphData(
	nodes: GraphNode[],
	edges: GraphEdge[],
	positionCache: Map<string, ForceNode>,
): { nodes: ForceNode[]; links: ForceLink[] } {
	const nodeIds = new Set(nodes.map((node) => node.id));
	const visibleEdges = edges
		.map((edge) => ({
			...edge,
			source: getEndpointId(edge.source),
			target: getEndpointId(edge.target),
		}))
		.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
	const communityByNode = assignCommunities(nodes, visibleEdges);
	return {
		nodes: nodes.map((node) => ({
			id: node.id,
			label: node.label,
			degreeBefore: node.degreeBefore,
			degreeAfter: node.degreeAfter,
			growth: node.degreeAfter > node.degreeBefore,
			community: communityByNode.get(node.id) ?? 0,
			x: positionCache.get(node.id)?.x,
			y: positionCache.get(node.id)?.y,
			vx: positionCache.get(node.id)?.vx,
			vy: positionCache.get(node.id)?.vy,
			fx: positionCache.get(node.id)?.fx,
			fy: positionCache.get(node.id)?.fy,
		})),
		links: visibleEdges.map((edge) => ({
			id: edge.id,
			source: edge.source,
			target: edge.target,
			projected: edge.projected,
		})),
	};
}

function getEndpointId(endpoint: unknown): string {
	if (typeof endpoint === "string") {
		return endpoint;
	}
	if (endpoint && typeof endpoint === "object" && "id" in endpoint) {
		const id = (endpoint as { id?: unknown }).id;
		return typeof id === "string" ? id : "";
	}
	return "";
}

function assignCommunities(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
	const adjacency = new Map<string, Set<string>>();
	for (const node of nodes) {
		adjacency.set(node.id, new Set<string>());
	}
	for (const edge of edges) {
		adjacency.get(edge.source)?.add(edge.target);
		adjacency.get(edge.target)?.add(edge.source);
	}
	const visited = new Set<string>();
	const communities = new Map<string, number>();
	let community = 0;
	for (const node of [...nodes].sort((left, right) => right.degreeAfter - left.degreeAfter)) {
		if (visited.has(node.id)) {
			continue;
		}
		const queue = [node.id];
		visited.add(node.id);
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) {
				continue;
			}
			communities.set(current, community);
			for (const next of adjacency.get(current) ?? []) {
				if (visited.has(next)) {
					continue;
				}
				visited.add(next);
				queue.push(next);
			}
		}
		community += 1;
	}
	return communities;
}

function communityAnchor(community: number): { x: number; y: number } {
	const angle = (community * 2.399963229728653) % (Math.PI * 2);
	const radius = 145 + (community % 4) * 34;
	return {
		x: Math.cos(angle) * radius,
		y: Math.sin(angle) * radius,
	};
}

function getNodeDegree(node: ForceNode): number {
	return Math.max(node.degreeBefore, node.degreeAfter);
}

function createCommunityForce(): ((alpha: number) => void) & { initialize: (nodes: ForceNode[]) => void } {
	let nodes: ForceNode[] = [];
	const force = (alpha: number) => {
		for (const node of nodes) {
			const anchor = communityAnchor(node.community);
			node.vx = (node.vx ?? 0) + (anchor.x - (node.x ?? 0)) * 0.018 * alpha;
			node.vy = (node.vy ?? 0) + (anchor.y - (node.y ?? 0)) * 0.018 * alpha;
		}
	};
	force.initialize = (nextNodes: ForceNode[]) => {
		nodes = nextNodes;
	};
	return force;
}

function createCollideForce(radiusForNode: (node: ForceNode) => number): ((alpha: number) => void) & { initialize: (nodes: ForceNode[]) => void } {
	let nodes: ForceNode[] = [];
	const force = (alpha: number) => {
		for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
			const left = nodes[leftIndex];
			if (!left) {
				continue;
			}
			for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
				const right = nodes[rightIndex];
				if (!right) {
					continue;
				}
				const dx = (right.x ?? 0) - (left.x ?? 0);
				const dy = (right.y ?? 0) - (left.y ?? 0);
				const distance = Math.sqrt(dx * dx + dy * dy) || 1;
				const minDistance = radiusForNode(left) + radiusForNode(right);
				if (distance >= minDistance) {
					continue;
				}
				const push = ((minDistance - distance) / distance) * 0.18 * alpha;
				const offsetX = dx * push;
				const offsetY = dy * push;
				left.vx = (left.vx ?? 0) - offsetX;
				left.vy = (left.vy ?? 0) - offsetY;
				right.vx = (right.vx ?? 0) + offsetX;
				right.vy = (right.vy ?? 0) + offsetY;
			}
		}
	};
	force.initialize = (nextNodes: ForceNode[]) => {
		nodes = nextNodes;
	};
	return force;
}

function getNodePositions(nodes: ForceNode[]): Map<string, ForceNode> {
	return new Map(nodes.map((node) => [node.id, node]));
}

function renderStats(containerEl: HTMLElement, analysis: VaultAnalysisResult, mode: GraphMode, edgeCount: number): void {
	containerEl.empty();
	const title = containerEl.createDiv({ cls: "semantic-auto-linker-graph-summary-title" });
	setIcon(title.createSpan({ cls: "semantic-auto-linker-graph-summary-icon" }), mode === "before" ? "git-branch" : "sparkles");
	title.createSpan({ text: mode === "before" ? "Current graph" : "Projected graph" });
	containerEl.createDiv({ text: `Notes: ${analysis.graphPreview.nodes.length}` });
	containerEl.createDiv({ text: `Visible edges: ${edgeCount}` });
	containerEl.createDiv({ text: `Existing links: ${analysis.graphMetrics.existingLinkCount}` });
	containerEl.createDiv({ text: `Added links: ${analysis.graphMetrics.projectedAddedLinks}` });
}

function renderTopList(containerEl: HTMLElement, nodes: GraphNode[], mode: GraphMode): void {
	containerEl.empty();
	containerEl.createEl("h4", { text: mode === "before" ? "Most connected now" : "Most connected after apply" });
	const list = containerEl.createEl("ul");
	const sorted = [...nodes]
		.sort((left, right) => {
			const leftDegree = mode === "before" ? left.degreeBefore : left.degreeAfter;
			const rightDegree = mode === "before" ? right.degreeBefore : right.degreeAfter;
			return rightDegree - leftDegree || left.label.localeCompare(right.label);
		})
		.slice(0, 8);

	for (const node of sorted) {
		const degree = mode === "before" ? node.degreeBefore : node.degreeAfter;
		const delta = node.degreeAfter - node.degreeBefore;
		list.createEl("li", {
			text: mode === "after" && delta > 0 ? `${node.label}: ${degree} (+${delta})` : `${node.label}: ${degree}`,
		});
	}
}

function drawNodeLabel(node: ForceNode, ctx: CanvasRenderingContext2D, globalScale: number): void {
	if (globalScale < 0.85) {
		return;
	}
	const label = truncate(node.label, 18);
	const fontSize = Math.max(8 / globalScale, 3.4);
	ctx.font = `${fontSize}px sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";

	const x = Number(node.x ?? 0);
	const y = Number(node.y ?? 0);
	const nodeSize = 2.8 + Math.min(3.8, Math.max(node.degreeAfter, node.degreeBefore) * 0.28);
	const padding = 2 / globalScale;
	const textWidth = ctx.measureText(label).width;

	ctx.fillStyle = "rgba(20, 26, 33, 0.56)";
	ctx.fillRect(
		x - textWidth / 2 - padding,
		y + nodeSize + 3 / globalScale,
		textWidth + padding * 2,
		fontSize + padding * 2,
	);

	ctx.fillStyle = "rgba(235, 240, 245, 0.92)";
	ctx.fillText(label, x, y + nodeSize + fontSize / 2 + 3 / globalScale);
}

function createModeButton(containerEl: HTMLElement, text: string, onClick: () => void): HTMLButtonElement {
	const button = containerEl.createEl("button", { text });
	button.onclick = onClick;
	return button;
}

function truncate(value: string, length: number): string {
	if (value.length <= length) {
		return value;
	}
	return `${value.slice(0, length - 3)}...`;
}
