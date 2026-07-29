/**
 * Example: Global Search Integration for Documentation Portal
 * This shows how to integrate the global search into a Next.js application
 */

import React, { useEffect, useState } from 'react';
import { SearchModal } from '../components/SearchModal';
import { SearchIndexEntry } from '../hooks/useGlobalSearch';

/**
 * Next.js Page Example
 * pages/docs/index.tsx
 */
export function DocsPage() {
  const [searchIndex, setSearchIndex] = useState<SearchIndexEntry[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Load search index on mount
  useEffect(() => {
    async function loadSearchIndex() {
      try {
        const response = await fetch('/api/search/index');
        const data = await response.json();
        setSearchIndex(data);
      } catch (error) {
        console.error('Failed to load search index:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadSearchIndex();
  }, []);

  if (isLoading) {
    return <div>Loading documentation...</div>;
  }

  return (
    <>
      {/* Search Modal */}
      <SearchModal
        index={searchIndex}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />

      {/* Page Header with Search Button */}
      <header className="header">
        <h1>Documentation</h1>
        <button
          className="search-trigger"
          onClick={() => setIsSearchOpen(true)}
          title="Open search (Cmd+K)"
        >
          🔍 Search
          <kbd>Cmd+K</kbd>
        </button>
      </header>

      {/* Documentation content */}
      <main className="docs-content">{/* Your docs content */}</main>
    </>
  );
}

/**
 * Next.js API Route
 * pages/api/search/index.ts
 */
export async function searchIndexHandler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Load pre-generated search index
    const index = require('../../../public/data/search-index.json');
    res.status(200).json(index);
  } catch (error) {
    console.error('Failed to load search index:', error);
    res.status(500).json({ error: 'Failed to load search index' });
  }
}

/**
 * Build-time: Generate and serve search index
 * scripts/generate-search-index.ts
 * 
 * Run as part of your build process:
 * "build": "npm run generate-search-index && next build"
 */
import { generateFullSearchIndex, saveIndexToJSON } from '../utils/generateSearchIndex';
import * as path from 'path';
import * as fs from 'fs';

export async function generateSearchIndexBuild() {
  try {
    console.log('📚 Generating search index...');

    const docsDir = path.join(process.cwd(), 'docs');
    const outputPath = path.join(process.cwd(), 'public/data/search-index.json');

    // Load OpenAPI schema (from your generated spec)
    let openApiSchema = { paths: {} };
    const schemaPath = path.join(process.cwd(), 'docs/api-schema.json');
    if (fs.existsSync(schemaPath)) {
      openApiSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    }

    // Generate full index
    const index = generateFullSearchIndex(
      docsDir,
      openApiSchema,
      path.join(process.cwd(), 'docs/examples')
    );

    // Save to public directory
    saveIndexToJSON(index, outputPath);

    console.log(
      `✅ Search index generated: ${index.length} entries indexed`
    );
    return index;
  } catch (error) {
    console.error('❌ Failed to generate search index:', error);
    throw error;
  }
}

/**
 * React Component: Search Trigger Button with Keyboard Hint
 */
export function SearchButton({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <button
      className="search-button"
      onClick={onClick}
      aria-label="Open search"
      title="Search (Cmd+K)"
    >
      <span className="search-icon">🔍</span>
      <span className="search-text">Search</span>
      <kbd className="search-hint">Cmd+K</kbd>
    </button>
  );
}

/**
 * Styles for Search Button
 */
const SearchButtonStyles = `
.search-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: white;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}

.search-button:hover {
  border-color: #0066cc;
  background: #f9f9f9;
}

.search-icon {
  font-size: 16px;
}

.search-hint {
  background: #f0f0f0;
  border: 1px solid #ddd;
  border-radius: 3px;
  padding: 2px 6px;
  font-family: monospace;
  font-size: 12px;
  font-weight: 600;
  margin-left: 8px;
}

/* Mobile */
@media (max-width: 768px) {
  .search-button {
    padding: 6px 10px;
    font-size: 12px;
  }

  .search-hint {
    display: none;
  }

  .search-text {
    display: none;
  }
}
`;

/**
 * Build Script: Add to package.json
 */
const packageJsonUpdates = {
  scripts: {
    'generate-search-index': 'ts-node scripts/generate-search-index.ts',
    'build': 'npm run generate-search-index && next build',
    'dev': 'next dev',
  },
  devDependencies: {
    'typescript': '^5.0.0',
    '@types/react': '^18.0.0',
    '@testing-library/react': '^14.0.0',
    '@testing-library/user-event': '^14.0.0',
  },
};

/**
 * Next.js Config: Optimize search index loading
 * next.config.js
 */
const nextConfigExample = `
module.exports = {
  // Enable static generation for search index
  staticPageGenerationTimeout: 120,

  // Optimize search index build
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.optimization.splitChunks.cacheGroups = {
        ...config.optimization.splitChunks.cacheGroups,
        search: {
          test: /[\\\\/]search[\\\\/]/,
          name: 'search',
          priority: 10,
          reuseExistingChunk: true,
        },
      };
    }
    return config;
  },
};
`;

/**
 * Docker support: Generate index during build
 * Dockerfile
 */
const dockerfileExample = `
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run generate-search-index
RUN npm run build

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY package*.json ./
RUN npm ci --production
CMD ["npm", "start"]
`;

/**
 * GitHub Actions: Pre-generate search index on PR
 * .github/workflows/generate-search-index.yml
 */
const githubActionsExample = `
name: Generate Search Index

on:
  push:
    paths:
      - 'docs/**'
      - 'src/**'
  pull_request:
    paths:
      - 'docs/**'
      - 'src/**'

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run generate-search-index
      - uses: actions/upload-artifact@v3
        with:
          name: search-index
          path: public/data/search-index.json
`;

export default {
  DocsPage,
  searchIndexHandler,
  generateSearchIndexBuild,
  SearchButton,
  SearchButtonStyles,
  packageJsonUpdates,
  nextConfigExample,
  dockerfileExample,
  githubActionsExample,
};
