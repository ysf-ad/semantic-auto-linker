declare module "tsne-js" {
	interface TSNEOptions {
		dim?: number;
		perplexity?: number;
		earlyExaggeration?: number;
		learningRate?: number;
		nIter?: number;
		metric?: string;
	}

	interface TSNEInitOptions {
		data: number[][];
		type?: "dense" | "sparse";
	}

	export default class TSNE {
		constructor(options?: TSNEOptions);
		init(options: TSNEInitOptions): void;
		run(): [number, number];
		getOutput(): number[][];
		getOutputScaled(): number[][];
	}
}

declare module "three-spritetext" {
	import { Object3D, Vector3 } from "three";

	export default class SpriteText extends Object3D {
		constructor(text?: string, textHeight?: number, color?: string);
		text: string;
		textHeight: number;
		color: string;
		backgroundColor: string;
		padding: number;
		position: Vector3;
	}
}

declare module "d3-force-3d" {
	export function forceCenter(x?: number, y?: number, z?: number): unknown;
	export function forceManyBody(): {
		strength(value: number): unknown;
	};
	export function forceRadial(radius?: number, x?: number, y?: number, z?: number): {
		strength(value: number): unknown;
	};
}
