declare module "d3-force-3d" {
	export interface SimulationNodeDatum {
		x?: number;
		y?: number;
		z?: number;
		vx?: number;
		vy?: number;
		vz?: number;
		fx?: number | null;
		fy?: number | null;
		fz?: number | null;
		index?: number;
	}

	export interface SimulationLinkDatum<NodeDatum extends SimulationNodeDatum> {
		source: NodeDatum | string | number;
		target: NodeDatum | string | number;
		index?: number;
	}

	export interface Force<NodeDatum extends SimulationNodeDatum, LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>> {
		(alpha: number): void;
		initialize?(nodes: NodeDatum[], random?: () => number): void;
		strength(strength: number): this;
		links?(links: LinkDatum[]): this;
		id?(id: (node: NodeDatum) => string): this;
	}

	export function forceCenter<NodeDatum extends SimulationNodeDatum>(x?: number, y?: number, z?: number): Force<NodeDatum>;
	export function forceLink<NodeDatum extends SimulationNodeDatum, LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>>(
		links?: LinkDatum[],
	): Force<NodeDatum, LinkDatum>;
	export function forceManyBody<NodeDatum extends SimulationNodeDatum>(): Force<NodeDatum>;
	export function forceRadial<NodeDatum extends SimulationNodeDatum>(radius?: number, x?: number, y?: number, z?: number): Force<NodeDatum>;
}
