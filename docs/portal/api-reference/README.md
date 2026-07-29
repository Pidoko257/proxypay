# Interactive Redoc API Reference - Complete Documentation

## Overview

A production-ready, fully integrated Redoc-powered API reference page for the ProxyPay documentation portal with:

- **Interactive Redoc viewer** for OpenAPI 3.0 specs
- **Sidebar navigation** with API tags and operation organization
- **Deep-linking** to specific endpoints with URL parameters
- **Search and filtering** across all endpoints
- **Responsive design** for desktop, tablet, and mobile
- **Dark mode support** with automatic detection
- **Keyboard shortcuts** for power users
- **Spec caching** for performance optimization
- **Docusaurus integration** ready
- **Full accessibility** (WCAG 2.1 AA)

## Architecture

### File Structure

```
docs/portal/api-reference/
├── RedocWrapper.tsx              # Main Redoc wrapper component
├── RedocWrapper.module.css       # Redoc wrapper styles
├── ApiReferencePage.tsx          # Full page component with sidebar
├── ApiReferencePage.module.css   # Page styles
├── useApiReference.ts            # React hook for state management
├── specUtils.ts                  # OpenAPI spec utilities
├── sidebarGenerator.ts           # Sidebar structure generation
├── index.ts                      # Barrel exports
├── README.md                     # This file
└── __tests__/                    # Test suite
```

### Components

#### RedocWrapper
Standalone wrapper for Redoc with deep-linking and theme support.

**Features:**
- Renders Redoc from OpenAPI spec URL
- Handles deep-linking to specific operations
- Custom theme configuration
- Error handling and retry logic
- Loading states

**Props:**
```tsx
interface RedocWrapperProps {
  specUrl: string;                 // URL to OpenAPI spec
  title?: string;                  // Custom title
  theme?: Record<string, any>;     // Theme configuration
  enableSearch?: boolean;          // Enable search
  deepLink?: string;               // Deep link target
  onSpecLoaded?: (spec) => void;   // Callback when loaded
  onNavigate?: (deepLink) => void; // Navigation callback
  className?: string;              // CSS class
  showLoader?: boolean;            // Show loading indicator
  disableScroll?: boolean;         // Disable scroll behavior
}
```

**Usage:**
```tsx
import { RedocWrapper } from '@/docs/portal/api-reference';

<RedocWrapper
  specUrl="/api/openapi.json"
  title="ProxyPay API"
  enableSearch={true}
/>
```

#### ApiReferencePage
Complete page component with sidebar, search, and breadcrumbs.

**Features:**
- Sidebar navigation with tag grouping
- Search/filter functionality
- Breadcrumb navigation
- Mobile-responsive sidebar toggle
- Integration with Redoc
- Deep-linking support

**Props:**
```tsx
interface ApiReferencePageProps {
  specUrl: string;                 // URL to OpenAPI spec
  baseUrl?: string;                // Base URL for links
  title?: string;                  // Page title
  theme?: Record<string, any>;     // Theme config
  showSidebar?: boolean;           // Show sidebar
  showSearch?: boolean;            // Show search
  onNavigate?: (operationId) => void;
}
```

**Usage:**
```tsx
import { ApiReferencePage } from '@/docs/portal/api-reference';

<ApiReferencePage
  specUrl="/api/openapi.json"
  title="ProxyPay API Reference"
  showSidebar={true}
  showSearch={true}
/>
```

### Hook: useApiReference

Custom hook for managing API reference state and behavior.

**Features:**
- Spec loading and caching
- Sidebar state management
- Search/filter logic
- Deep-linking handling
- Keyboard shortcuts
- Window resize handling

**Return Value:**
```tsx
interface UseApiReferenceReturn {
  // State
  spec: Record<string, any> | null;
  isLoading: boolean;
  error: string | null;
  isSidebarOpen: boolean;
  searchQuery: string;
  currentOperationId: string | null;
  selectedOperation: ApiOperation | null;
  sidebarItems: SidebarItem[];
  filteredSidebarItems: SidebarItem[];
  tags: Array<{ name: string; description? }>;

  // Actions
  setIsSidebarOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  selectOperation: (operationId: string) => void;
  refreshSpec: () => Promise<void>;
  clearSearch: () => void;
  exportSpec: () => void;
}
```

**Usage:**
```tsx
const {
  spec,
  isLoading,
  sidebarItems,
  currentOperationId,
  selectOperation,
  setSearchQuery,
} = useApiReference({
  specUrl: '/api/openapi.json',
  baseUrl: '/docs/api',
  enableKeyboardShortcuts: true,
  enableSearch: true,
  onOperationSelect: (opId) => console.log('Selected:', opId),
});
```

### Utilities: specUtils

**Functions:**

#### `fetchOpenAPISpec(url, options?)`
Fetch OpenAPI spec with caching support.

```tsx
const spec = await fetchOpenAPISpec('/api/openapi.json', {
  skipCache: false,
  forceRefresh: false,
});
```

#### `extractMetadata(spec)`
Extract title, version, contact info from spec.

```tsx
const { title, version, contact } = extractMetadata(spec);
```

#### `extractTags(spec)`
Get all tags from spec.

```tsx
const tags = extractTags(spec);
// [{ name: 'Auth', description: '...' }, ...]
```

#### `extractOperationsByTag(spec)`
Get operations grouped by tag.

```tsx
const ops = extractOperationsByTag(spec);
// { 'Auth': [...], 'Transactions': [...] }
```

#### `searchOperations(spec, query)`
Search operations by query string.

```tsx
const results = searchOperations(spec, 'transaction');
```

#### `getOperation(spec, operationId)`
Get specific operation by ID.

```tsx
const op = getOperation(spec, 'listTransactions');
```

#### `generateCodeExample(operation, language, baseUrl)`
Generate code examples in curl, JavaScript, or Python.

```tsx
const curl = generateCodeExample(operation, 'curl');
const js = generateCodeExample(operation, 'javascript');
```

### Sidebar Generator: sidebarGenerator

**Functions:**

#### `generateApiSidebarFromSpec(spec, baseUrl?)`
Generate sidebar structure from OpenAPI spec.

```tsx
const sidebar = generateApiSidebarFromSpec(spec, '/docs/api');
// Returns: SidebarItem[]
```

#### `convertToDocusaurusSidebar(items, sectionLabel?)`
Convert to Docusaurus format.

```tsx
const docusaurusSidebar = convertToDocusaurusSidebar(sidebarItems);
// Suitable for docusaurus.config.js sidebars
```

#### `filterSidebarItems(items, query)`
Filter sidebar by search query.

```tsx
const filtered = filterSidebarItems(sidebarItems, 'payment');
```

#### `generateBreadcrumbs(items, operationId)`
Generate breadcrumb navigation.

```tsx
const breadcrumbs = generateBreadcrumbs(sidebarItems, opId);
// [{ label: 'API' }, { label: 'Transactions' }, ...]
```

## Integration Guide

### 1. Install Dependencies

```bash
npm install redoc @redocly/openapi-core
```

**Note:** Redoc is typically loaded from CDN. Update your HTML:

```html
<!-- In public/index.html or document head -->
<script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
```

### 2. Setup Docusaurus Custom Page

Create custom page file:

```tsx
// docusaurus/pages/api-reference.tsx
import React from 'react';
import Layout from '@theme/Layout';
import { ApiReferencePage } from '@/docs/portal/api-reference';

export default function ApiReferencePage(): JSX.Element {
  return (
    <Layout title="API Reference" description="ProxyPay API Documentation">
      <ApiReferencePage
        specUrl="/api/openapi.json"
        title="ProxyPay API Reference"
        showSidebar={true}
        showSearch={true}
      />
    </Layout>
  );
}
```

### 3. Add to Docusaurus Sidebar

In `docusaurus.config.js`:

```js
const sidebars = {
  docs: [
    { type: 'doc', id: 'intro' },
    {
      type: 'link',
      label: 'API Reference',
      href: '/docs/api-reference',
    },
  ],
};
```

### 4. Serve OpenAPI Spec

Add route to serve spec (if not already available):

```tsx
// src/routes/docs.ts
app.get('/api/openapi.json', (req, res) => {
  const spec = generateOpenAPIDocument();
  res.json(spec);
});
```

### 5. Configure Theme

Customize theme in component:

```tsx
const theme = {
  colors: {
    primary: { main: '#007bff' },
    text: { primary: '#1a1a1a' },
  },
  typography: {
    fontFamily: 'system-ui, sans-serif',
  },
};

<ApiReferencePage
  specUrl="/api/openapi.json"
  theme={theme}
/>
```

## Features

### Deep-Linking

Navigate to specific operations via URL:

```
/docs/api-reference?operationId=listTransactions
/docs/api-reference?operationId=createTransaction
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` / `Cmd+K` | Focus search |
| `Esc` | Close sidebar (mobile) |
| `?` | Show help (future) |

### Search & Filter

- Search by operation ID, path, summary, or tags
- Real-time result filtering
- Sidebar updates as you type
- Clear button for quick reset

### Responsive Design

- **Desktop**: Full sidebar + Redoc panel
- **Tablet**: Collapsible sidebar
- **Mobile**: Hamburger menu, full-screen sidebar overlay

### Dark Mode

Automatically adapts to system preference via `prefers-color-scheme`.

### Accessibility

- WCAG 2.1 AA compliant
- Semantic HTML
- ARIA labels
- Keyboard navigation
- Focus management
- High contrast support

## Usage Examples

### Basic Integration

```tsx
import { ApiReferencePage } from '@/docs/portal/api-reference';

export function Docs() {
  return (
    <ApiReferencePage
      specUrl="https://api.example.com/openapi.json"
    />
  );
}
```

### With Custom Theme

```tsx
import { ApiReferencePage } from '@/docs/portal/api-reference';

const customTheme = {
  colors: {
    primary: { main: '#6366f1' },
    success: { main: '#10b981' },
    warning: { main: '#f59e0b' },
    error: { main: '#ef4444' },
  },
};

export function Docs() {
  return (
    <ApiReferencePage
      specUrl="/api/openapi.json"
      theme={customTheme}
    />
  );
}
```

### Using the Hook Directly

```tsx
import { useApiReference, RedocWrapper } from '@/docs/portal/api-reference';

export function CustomApiRef() {
  const {
    spec,
    isLoading,
    sidebarItems,
    selectOperation,
    searchQuery,
    setSearchQuery,
  } = useApiReference({
    specUrl: '/api/openapi.json',
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <div style={{ display: 'flex' }}>
      {/* Custom sidebar */}
      <aside>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search..."
        />
        {sidebarItems.map(tag => (
          <div key={tag.id}>
            <h3>{tag.label}</h3>
            <ul>
              {tag.children?.map(op => (
                <li key={op.id}>
                  <button onClick={() => selectOperation(op.metadata?.operationId || '')}>
                    {op.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>

      {/* Redoc */}
      <main>
        <RedocWrapper specUrl="/api/openapi.json" />
      </main>
    </div>
  );
}
```

## Performance Optimization

### Spec Caching

Specs are cached for 5 minutes by default:

```tsx
// Clear cache
import { clearSpecCache } from '@/docs/portal/api-reference';

clearSpecCache();
// or clear specific URL
clearSpecCache('/api/openapi.json');
```

### Preload Spec

Warm cache by preloading:

```tsx
import { preloadSpec } from '@/docs/portal/api-reference';

useEffect(() => {
  preloadSpec('/api/openapi.json');
}, []);
```

### Get Cache Stats

Monitor cache usage:

```tsx
import { getSpecCacheStats } from '@/docs/portal/api-reference';

const stats = getSpecCacheStats();
// { size: 1, entries: [...], oldestEntry: {...} }
```

## Testing

### Unit Tests

```bash
npm test -- docs/portal/api-reference/__tests__/
```

### Integration Tests

Test with actual OpenAPI spec and Redoc rendering.

### Accessibility Testing

- Use axe DevTools
- Test keyboard navigation
- Verify screen reader compatibility

## Troubleshooting

### Redoc not loading

**Issue:** "Redoc library not loaded"

**Solution:** Ensure Redoc is loaded from CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
```

### Deep-linking not working

**Issue:** URL parameters ignored

**Solution:** Ensure `useLocation` and `useNavigate` from React Router are working:

```tsx
// In Docusaurus, wrap in proper router context
```

### Sidebar not appearing

**Issue:** Empty sidebar

**Solution:** Check spec is valid OpenAPI 3.0 with `tags` defined:

```json
{
  "openapi": "3.0.0",
  "tags": [
    { "name": "Auth" },
    { "name": "Transactions" }
  ],
  "paths": { ... }
}
```

### Styling conflicts

**Issue:** Styles not applying

**Solution:** Ensure CSS modules are imported correctly:

```tsx
import styles from './ApiReferencePage.module.css';
```

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile browsers (iOS Safari 14+, Chrome Android)

## License

MIT - Part of ProxyPay project

## See Also

- [Redoc Documentation](https://redoc.ly/)
- [OpenAPI 3.0 Spec](https://spec.openapis.org/)
- [Docusaurus](https://docusaurus.io/)
