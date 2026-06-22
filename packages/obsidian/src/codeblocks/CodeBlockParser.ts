import { buildCodeBlockMeta, parseCodeBlockMeta } from 'packages/obsidian/src/codeblocks/CodeBlockMeta';
import { makeParsedCodeBlockIdentity } from 'packages/obsidian/src/codeblocks/CodeBlockIdentity';
import type { CodeBlockLineInfo, ParsedCodeBlockModel } from 'packages/obsidian/src/codeblocks/CodeBlockModel';

export class CodeBlockParser {
	parseLivePreviewBlocks(lines: readonly CodeBlockLineInfo[]): ParsedCodeBlockModel[] {
		const blocks: ParsedCodeBlockModel[] = [];
		let current: { closingFence: string; openingLine: number; language: string; from: number } | undefined;
		const getLine = (lineNumber: number): CodeBlockLineInfo | undefined => lines[lineNumber - 1];

		for (const line of lines) {
			const opening = parseCodeBlockMeta(line.text);

			if (!current) {
				if (!opening) {
					continue;
				}

				const canonicalLanguage = opening.language;
				if (!canonicalLanguage?.trim()) {
					continue;
				}

				current = {
					closingFence: opening.openingFence,
					openingLine: line.lineNumber,
					language: canonicalLanguage.trim().toLowerCase(),
					from: line.from,
				};
				continue;
			}

			if (line.text.trim().startsWith(current.closingFence)) {
				const codeStartLine = current.openingLine + 1;
				const codeEndLine = line.lineNumber - 1;
				if (codeStartLine <= codeEndLine && current.language !== '') {
					const codeFromLine = getLine(codeStartLine);
					const codeToLine = getLine(codeEndLine);
					const openingLine = getLine(current.openingLine);

					if (codeFromLine && codeToLine && openingLine) {
						const meta = buildCodeBlockMeta(openingLine.text);
						if (!meta) {
							current = undefined;
							continue;
						}

						blocks.push({
							blockId: makeParsedCodeBlockIdentity(current.from, current.openingLine, current.closingFence),
							language: current.language,
							range: {
								lineFrom: codeStartLine,
								lineTo: codeEndLine,
								charFrom: codeFromLine.from,
								charTo: codeToLine.to,
							},
							meta: {
								raw: meta.rawMeta,
								openingFence: meta.openingFence,
							},
							openingFenceLine: current.openingLine,
							closingFenceLine: line.lineNumber,
						});
					}
				}

				current = undefined;
			}
		}

		return blocks;
	}
}
