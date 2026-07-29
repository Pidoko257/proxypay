/**
 * Redoc API Reference - Docusaurus Integration Example
 * 
 * Shows how to integrate the Redoc API reference page into a Docusaurus setup
 */

// ============================================================================
// 1. Docusaurus Custom Page (pages/api-reference.tsx)
// ============================================================================

import React from 'react';
import Layout from '@theme/Layout';
import { ApiReferencePage } from '@/docs/portal/api-reference';

/**
 * Custom Docusaurus page for API reference
 * This gets rendered at /docs/api-reference route
 */
export default function ApiReferencePageComponent(): JSX.Element {
  return (
    <Layout
      title="API Reference"
      description="ProxyPay Interactive API Documentation"
    >
      <ApiReferencePage
        specUrl="/api/openapi.json"
        title="ProxyPay API Reference"
        baseUrl="/docs/api-reference"
        showSidebar={true}
        showSearch={true}
        theme={{
          colors: {
            primary: {
              main: '#007bff',
            },
            success: {
              main: '#28a745',
            },
            warning: {
              main: '#ffc107',
            },
            error: {
              main: '#dc3545',
            },
            text: {
              primary: '#1a1a1a',
              secondary: '#666666',
            },
          },
          typography: {
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif',
          },
        }}
        onNavigate={(operationId) => {
          // Optional: Analytics or logging
          console.log('Navigated to:', operationId);
        }}
      />
    </Layout>
  );
}

// ============================================================================
// 2. docusaurus.config.js Configuration
// ============================================================================

/**
 * Add to your docusaurus.config.js:
 */

export const docusaurusConfig = {
  // ... existing config ...

  // Add custom pages directory
  customPages: ['pages/api-reference.tsx'],

  // Add API reference to sidebar
  themeConfig: {
    navbar: {
      items: [
        // ... existing items ...
        {
          label: 'API',
          to: 'docs/api-reference',
          position: 'right',
        },
      ],
    },
  },

  // Optional: Setup API docs plugin
  plugins: [
    [
      'docusaurus-plugin-openapi-docs',
      {
        id: 'openapi',
        docsPluginId: 'classic',
        config: {
          proxypay: {
            specPath: '../src/openapi/schemas',
            outputPath: 'docs/openapi/proxypay',
            downloadUrl:
              'https://api.proxypay.app/api/openapi.json',
            sidebar: {
              groupPathOperations: true,
              autogenSidebarSlice: true,
            },
          },
        },
      },
    ],
  ],

  // Optional: Add to markdown frontmatter
  markdown: {
    format: 'md',
    mermaid: true,
  },
};

// ============================================================================
// 3. Express Route to Serve OpenAPI Spec
// ============================================================================

/**
 * In your Express app (src/routes/docs.ts or similar):
 */

import { Router } from 'express';
import { generateOpenAPIDocument } from '../openapi/generator';

const router = Router();

/**
 * Serve OpenAPI spec
 * GET /api/openapi.json
 */
router.get('/openapi.json', (req, res) => {
  try {
    const spec = generateOpenAPIDocument();

    // Set cache headers for browser caching
    res.set({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    });

    res.json(spec);
  } catch (error) {
    console.error('Failed to generate OpenAPI spec:', error);
    res.status(500).json({ error: 'Failed to generate OpenAPI spec' });
  }
});

/**
 * Optional: Serve OpenAPI UI
 * GET /docs
 */
router.get('/docs', (req, res) => {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>ProxyPay API Documentation</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
        <style>
          body {
            margin: 0;
            padding: 0;
          }
        </style>
      </head>
      <body>
        <redoc spec-url='/api/openapi.json'></redoc>
        <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"> </script>
      </body>
    </html>
  `;
  res.send(htmlContent);
});

export default router;

// ============================================================================
// 4. React Component Integration (if not using Docusaurus)
// ============================================================================

/**
 * Direct component usage in a Next.js or React app:
 */

import React, { useState } from 'react';
import { ApiReferencePage, useApiReference } from '@/docs/portal/api-reference';

export function MyApiDocs() {
  const [lastNavigated, setLastNavigated] = useState<string | null>(null);

  return (
    <div>
      {lastNavigated && (
        <div
          style={{
            padding: '1rem',
            background: '#e7f3ff',
            border: '1px solid #0066cc',
            borderRadius: '0.5rem',
            marginBottom: '1rem',
          }}
        >
          Last viewed: <code>{lastNavigated}</code>
        </div>
      )}

      <ApiReferencePage
        specUrl="https://api.proxypay.app/openapi.json"
        title="ProxyPay API Documentation"
        showSidebar={true}
        showSearch={true}
        onNavigate={setLastNavigated}
      />
    </div>
  );
}

// ============================================================================
// 5. Advanced: Custom Hook Usage
// ============================================================================

/**
 * Using the hook directly for advanced customization:
 */

import { useApiReference, RedocWrapper } from '@/docs/portal/api-reference';
import styles from './CustomApiDocs.module.css';

export function CustomApiDocumentation() {
  const {
    spec,
    isLoading,
    error,
    sidebarItems,
    filteredSidebarItems,
    currentOperationId,
    searchQuery,
    isSidebarOpen,
    setSearchQuery,
    setIsSidebarOpen,
    selectOperation,
    refreshSpec,
    exportSpec,
  } = useApiReference({
    specUrl: '/api/openapi.json',
    enableKeyboardShortcuts: true,
    enableSearch: true,
    onOperationSelect: (opId) => console.log('Selected:', opId),
  });

  if (isLoading) {
    return <div className={styles.loading}>Loading API documentation...</div>;
  }

  if (error) {
    return (
      <div className={styles.error}>
        <h2>Failed to Load API</h2>
        <p>{error}</p>
        <button onClick={refreshSpec}>Retry</button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Custom header */}
      <header className={styles.header}>
        <h1>ProxyPay API</h1>
        <div className={styles.headerActions}>
          <input
            type="text"
            placeholder="Search endpoints..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button onClick={exportSpec}>Download Spec</button>
          <button onClick={refreshSpec}>Refresh</button>
        </div>
      </header>

      {/* Custom sidebar */}
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <h2>Endpoints</h2>
          {filteredSidebarItems.map((tag) => (
            <div key={tag.id} className={styles.tagGroup}>
              <h3>{tag.label}</h3>
              <ul>
                {tag.children?.map((op) => (
                  <li
                    key={op.id}
                    className={
                      currentOperationId === op.metadata?.operationId
                        ? styles.active
                        : ''
                    }
                  >
                    <button
                      onClick={() =>
                        selectOperation(op.metadata?.operationId || '')
                      }
                    >
                      {op.metadata?.method} {op.metadata?.path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        {/* Redoc viewer */}
        <main className={styles.content}>
          <RedocWrapper
            specUrl="/api/openapi.json"
            deepLink={currentOperationId || undefined}
          />
        </main>
      </div>
    </div>
  );
}

// ============================================================================
// 6. Docusaurus Theme Setup
// ============================================================================

/**
 * swizzle.config.js for Docusaurus theme customization:
 */

export const swizzleConfig = {
  core: ['Header', 'Footer'],
  docs: ['DocRoot'],
  theme: [],
};

// ============================================================================
// 7. Environment Configuration
// ============================================================================

/**
 * .env or .env.local for API endpoint:
 */

export const envConfig = `
# API Documentation
REACT_APP_OPENAPI_URL=https://api.proxypay.app/api/openapi.json
# or for local development:
# REACT_APP_OPENAPI_URL=http://localhost:3000/api/openapi.json
`;

// ============================================================================
// 8. TypeScript Configuration
// ============================================================================

/**
 * tsconfig.json additions:
 */

export const tsConfigAdditions = {
  compilerOptions: {
    paths: {
      '@/docs/portal/api-reference': [
        'docs/portal/api-reference/index.ts',
      ],
      '@/docs/portal/*': ['docs/portal/*'],
    },
  },
};

// ============================================================================
// 9. Build Scripts
// ============================================================================

/**
 * Add to package.json scripts:
 */

export const packageJsonScripts = {
  'docs:build': 'docusaurus build',
  'docs:start': 'docusaurus start',
  'docs:api:generate': 'npm run generate:openapi',
  'docs:deploy': 'npm run docs:build && npm run docs:deploy:aws',
};

// ============================================================================
// 10. Testing
// ============================================================================

/**
 * Example test for API reference page:
 */

import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

describe('ApiReferencePage', () => {
  test('renders API reference page', async () => {
    render(
      <BrowserRouter>
        <ApiReferencePage
          specUrl="/api/openapi.json"
          title="Test API"
        />
      </BrowserRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Test API')).toBeInTheDocument();
    });
  });

  test('sidebar toggles on mobile', async () => {
    // Set mobile viewport
    window.innerWidth = 500;

    render(
      <BrowserRouter>
        <ApiReferencePage specUrl="/api/openapi.json" />
      </BrowserRouter>
    );

    const toggleButton = screen.getByLabelText('Toggle sidebar');
    expect(toggleButton).toBeInTheDocument();
  });
});
