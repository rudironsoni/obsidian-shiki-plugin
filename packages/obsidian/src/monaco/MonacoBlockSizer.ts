import type { CodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';

export interface MonacoBlockMetrics {
	fontSize: number;
	fontFamily: string;
	lineHeight: number;
	paddingTop: number;
	paddingBottom: number;
	width: number;
	height: number;
	lineCount: number;
}

export class MonacoBlockSizer {
	measure(block: CodeBlockModel, host: HTMLElement): MonacoBlockMetrics {
		const computed = getComputedStyle(host);
		const fontSize = Number.parseFloat(computed.fontSize) || 14;
		const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * 1.5;
		const paddingTop = 8;
		const paddingBottom = 8;
		const lineCount = Math.max(1, block.code.split('\n').length);
		const width = Math.max(host.clientWidth || host.getBoundingClientRect().width || 1, 1);
		const height = lineCount * lineHeight + paddingTop + paddingBottom;

		return {
			fontSize,
			fontFamily: computed.fontFamily,
			lineHeight,
			paddingTop,
			paddingBottom,
			width,
			height,
			lineCount,
		};
	}
}
