import type { TokensResult } from 'shiki';

interface CacheKeyInput {
	sourcePath: string;
	language: string;
	theme: string;
	contentHash: string;
	settingsSignature: string;
}

function makeCacheKey(input: CacheKeyInput): string {
	return [input.sourcePath, input.language, input.theme, input.contentHash, input.settingsSignature].join('::');
}

export class SourceModeTokenizationCache {
	private readonly cache = new Map<string, TokensResult | undefined>();

	get(input: CacheKeyInput): TokensResult | undefined {
		return this.cache.get(makeCacheKey(input));
	}

	set(input: CacheKeyInput, value: TokensResult | undefined): void {
		this.cache.set(makeCacheKey(input), value);
	}

	clear(): void {
		this.cache.clear();
	}
}
