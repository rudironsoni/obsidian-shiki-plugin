import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const source = readFileSync('dist/modern-monaco.js', 'utf8');
const compressed = gzipSync(source, { level: 9 }).toString('base64');
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
manifest.shikiModernMonacoFallback = compressed;

writeFileSync('dist/manifest.json', `${JSON.stringify(manifest, null, '\t')}\n`);

console.log(`Embedded compressed modern-monaco.js fallback in manifest.json (${source.length} chars, ${compressed.length} base64 chars)`);
