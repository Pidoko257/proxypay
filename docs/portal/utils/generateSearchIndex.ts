import * as fs from 'fs';
import * as path from 'path';
import { SearchIndexEntry } from './hooks/useGlobalSearch';

/**
 * Search Index Generator
 * Generates searchable index from documentation files, API schema, and code examples
 */

interface DocumentMetadata {
  title: string;
  description: string;
  tags?: string[];
}

/**
 * Extract metadata from markdown frontmatter
 */
function extractFrontmatter(content: string): DocumentMetadata {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
  const match = content.match(frontmatterRegex);

  const title = content.match(/^#\s+(.+)/m)?.[1] || 'Untitled';
  const description = content.match(/^(?:###|##|\*\*)?([^#\n*]+)/m)?.[1] || '';

  return {
    title: title.trim(),
    description: description.trim().slice(0, 200),
  };
}

/**
 * Generate index entries from markdown files
 */
export function generateDocsIndex(docsDir: string): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];

  function walkDir(dir: string, baseUrl: string = ''): void {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        walkDir(filePath, `${baseUrl}/${file}`);
      } else if (file.endsWith('.md') || file.endsWith('.mdx')) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const meta = extractFrontmatter(content);

          const id = file.replace(/\.(md|mdx)$/, '');
          entries.push({
            id: `docs-${id}`,
            title: meta.title,
            description: meta.description,
            category: 'docs',
            url: `/docs${baseUrl}/${id}`,
            tags: meta.tags || [],
            searchText: `${meta.title} ${meta.description} ${content}`.toLowerCase(),
          });
        } catch (err) {
          console.warn(`Failed to index ${filePath}:`, err);
        }
      }
    }
  }

  walkDir(docsDir);
  return entries;
}

/**
 * Generate index entries from OpenAPI/Swagger schema
 */
export function generateAPIIndex(
  openApiSchema: Record<string, any>
): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];

  if (!openApiSchema.paths) {
    return entries;
  }

  for (const [path, pathItem] of Object.entries(openApiSchema.paths)) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

      const operationObj = operation;
      const summary = operationObj.summary || `${method.toUpperCase()} ${path}`;
      const description = operationObj.description || '';
      const tags = operationObj.tags || [];

      entries.push({
        id: `api-${method}-${path.replace(/\//g, '-')}`,
        title: summary,
        description,
        category: 'api',
        url: `/api/${method}/${path}`,
        icon: getMethodIcon(method),
        tags,
        searchText: `${method} ${path} ${summary} ${description} ${tags.join(' ')}`.toLowerCase(),
      });
    }
  }

  return entries;
}

/**
 * Generate index entries from code examples
 */
export function generateGuideIndex(guideDir: string): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];

  if (!fs.existsSync(guideDir)) {
    return entries;
  }

  const files = fs.readdirSync(guideDir);

  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.js') && !file.endsWith('.tsx')) continue;

    try {
      const filePath = path.join(guideDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Extract code example metadata from comments
      const titleMatch = content.match(/\/\/\s*@title\s+(.+)/);
      const descriptionMatch = content.match(/\/\/\s*@description\s+(.+)/);
      const tagsMatch = content.match(/\/\/\s*@tags\s+(.+)/);

      if (!titleMatch) continue;

      const title = titleMatch[1].trim();
      const description = descriptionMatch?.[1].trim() || '';
      const tags = tagsMatch?.[1].split(',').map((t) => t.trim()) || [];

      entries.push({
        id: `guide-${file}`,
        title,
        description,
        category: 'guides',
        url: `/guides/${file.replace(/\.(ts|js|tsx)$/, '')}`,
        tags,
        searchText: `${title} ${description} ${tags.join(' ')} ${content}`.toLowerCase(),
      });
    } catch (err) {
      console.warn(`Failed to index guide ${file}:`, err);
    }
  }

  return entries;
}

/**
 * Combine all indices
 */
export function generateFullSearchIndex(
  docsDir: string,
  openApiSchema: Record<string, any>,
  guideDir?: string
): SearchIndexEntry[] {
  const allEntries: SearchIndexEntry[] = [];

  // Add docs
  allEntries.push(...generateDocsIndex(docsDir));

  // Add API endpoints
  allEntries.push(...generateAPIIndex(openApiSchema));

  // Add guides
  if (guideDir) {
    allEntries.push(...generateGuideIndex(guideDir));
  }

  return allEntries;
}

/**
 * Get icon for HTTP method
 */
function getMethodIcon(method: string): string {
  const icons: Record<string, string> = {
    get: '📖',
    post: '✍️',
    put: '🔄',
    patch: '📝',
    delete: '🗑️',
  };
  return icons[method.toLowerCase()] || '🔗';
}

/**
 * Export index to JSON
 */
export function saveIndexToJSON(
  entries: SearchIndexEntry[],
  outputPath: string
): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(entries, null, 2));
  console.log(`Search index saved to ${outputPath} (${entries.length} entries)`);
}

/**
 * Load index from JSON
 */
export function loadIndexFromJSON(filePath: string): SearchIndexEntry[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`Failed to load index from ${filePath}:`, err);
    return [];
  }
}

/**
 * CLI: Generate and save search index
 * Usage: npx ts-node generateSearchIndex.ts
 */
if (require.main === module) {
  const docsDir = path.join(__dirname, '../../docs');
  const outputDir = path.join(__dirname, '../public/data');
  const outputPath = path.join(outputDir, 'search-index.json');

  // Load OpenAPI schema (would normally come from your API)
  const openApiSchema = {
    paths: {
      '/api/transactions': {
        get: {
          summary: 'List transactions',
          description: 'Retrieve a paginated list of transactions',
          tags: ['Transactions'],
        },
        post: {
          summary: 'Create transaction',
          description: 'Create a new transaction',
          tags: ['Transactions'],
        },
      },
      '/api/vaults': {
        get: {
          summary: 'List vaults',
          description: 'Get all vaults for the authenticated user',
          tags: ['Vaults'],
        },
      },
    },
  };

  const guideDir = path.join(__dirname, '../examples');

  try {
    const index = generateFullSearchIndex(docsDir, openApiSchema, guideDir);
    saveIndexToJSON(index, outputPath);
    console.log('✅ Search index generated successfully');
  } catch (err) {
    console.error('❌ Failed to generate search index:', err);
    process.exit(1);
  }
}

export default {
  generateDocsIndex,
  generateAPIIndex,
  generateGuideIndex,
  generateFullSearchIndex,
  saveIndexToJSON,
  loadIndexFromJSON,
};
