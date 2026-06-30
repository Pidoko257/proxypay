import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenAPIDocument } from '../src/openapi/generator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const outputDir = resolve(__dirname, '..', 'docs');
const outputPath = resolve(outputDir, 'openapi.json');

mkdirSync(outputDir, { recursive: true });

const spec = generateOpenAPIDocument();
writeFileSync(outputPath, JSON.stringify(spec, null, 2), 'utf-8');

console.log(`OpenAPI spec written to ${outputPath}`);
