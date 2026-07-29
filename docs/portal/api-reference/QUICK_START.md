# Redoc API Reference - Quick Start Guide

## 30-Second Setup

### 1. Install Redoc

```bash
npm install redoc @redocly/openapi-core
```

### 2. Load Redoc Script

Add to your HTML head or Docusaurus theme layout:

```html
<script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
```

### 3. Create Component

```tsx
import { ApiReferencePage } from '@/docs/portal/api-reference';

export function ApiDocs() {
  return (
    <ApiReferencePage
      specUrl="/api/openapi.json"
      title="ProxyPay API"
    />
  );
}
```

### 4. Serve OpenAPI Spec

```tsx
// In your Express app
import { generateOpenAPIDocument } from '../openapi/generator';

app.get('/api/openapi.json', (req, res) => {
  res.json(generateOpenAPIDocument());
});
```

Done! ✅

## What You Get

✅ Interactive API documentation with Redoc
✅ Sidebar navigation by endpoint tags
✅ Deep-linking to specific operations
✅ Search/filter across endpoints
✅ Mobile-responsive design
✅ Dark mode support
✅ Keyboard shortcuts (Ctrl+K)
✅ Code examples (curl, JS, Python)
✅ WCAG 2.1 AA accessibility
✅ Full TypeScript support

## Key Components

### ApiReferencePage
Full-featured page with sidebar and search.

```tsx
<ApiReferencePage
  specUrl="/api/openapi.json"
  title="My API"
  showSidebar={true}
  showSearch={true}
/>
```

### RedocWrapper
Standalone Redoc viewer component.

```tsx
import { RedocWrapper } from '@/docs/portal/api-reference';

<RedocWrapper
  specUrl="/api/openapi.json"
  enableSearch={true}
/>
```

### useApiReference Hook
Manage API reference state and behavior.

```tsx
const {
  spec,
  sidebarItems,
  currentOperationId,
  selectOperation,
  setSearchQuery,
} = useApiReference({
  specUrl: '/api/openapi.json',
});
```

## Usage Examples

### Basic Integration

```tsx
import { ApiReferencePage } from '@/docs/portal/api-reference';

export default function Docs() {
  return <ApiReferencePage specUrl="/api/openapi.json" />;
}
```

### With Custom Theme

```tsx
const theme = {
  colors: {
    primary: { main: '#6366f1' },
    success: { main: '#10b981' },
  },
};

<ApiReferencePage
  specUrl="/api/openapi.json"
  theme={theme}
/>
```

### Docusaurus Custom Page

```tsx
// pages/api-reference.tsx
import Layout from '@theme/Layout';
import { ApiReferencePage } from '@/docs/portal/api-reference';

export default function ApiDocs() {
  return (
    <Layout title="API Reference">
      <ApiReferencePage specUrl="/api/openapi.json" />
    </Layout>
  );
}
```

### Using the Hook

```tsx
import { useApiReference, RedocWrapper } from '@/docs/portal/api-reference';

export function CustomApi() {
  const {
    sidebarItems,
    currentOperationId,
    selectOperation,
  } = useApiReference({
    specUrl: '/api/openapi.json',
  });

  return (
    <div style={{ display: 'flex' }}>
      <aside>
        {/* Your custom sidebar */}
        {sidebarItems.map(tag => (
          <button key={tag.id}>
            {tag.label}
          </button>
        ))}
      </aside>
      <main>
        <RedocWrapper specUrl="/api/openapi.json" />
      </main>
    </div>
  );
}
```

## Deep-Linking

Navigate directly to specific endpoints:

```
/docs/api-reference?operationId=listTransactions
/docs/api-reference?operationId=createTransaction
/docs/api-reference?operationId=getAccount
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` / `Cmd+K` | Focus search |
| `Esc` | Close sidebar (mobile) |

## Features

### Sidebar Navigation
- Organized by API tags
- Shows operation summaries
- Quick navigation links
- Icon indicators per tag type

### Search & Filter
- Real-time filtering
- Search by operation ID, path, summary
- Clear button for reset
- Instant results

### Responsive Design
- **Desktop**: Full sidebar + content
- **Tablet**: Collapsible sidebar
- **Mobile**: Hamburger menu

### Dark Mode
Automatically adapts to system preference.

## Advanced Options

### Custom Spec URL

```tsx
// From environment variable
<ApiReferencePage
  specUrl={process.env.REACT_APP_API_SPEC}
/>

// From relative path
<ApiReferencePage specUrl="/schemas/openapi.json" />

// From absolute URL
<ApiReferencePage specUrl="https://api.example.com/openapi.json" />
```

### Callbacks

```tsx
<ApiReferencePage
  specUrl="/api/openapi.json"
  onNavigate={(operationId) => {
    console.log('Navigated to:', operationId);
    // Track analytics, etc.
  }}
/>
```

### Skip Cache

```tsx
import { fetchOpenAPISpec } from '@/docs/portal/api-reference';

// Force refresh, bypass cache
const spec = await fetchOpenAPISpec('/api/openapi.json', {
  forceRefresh: true,
});
```

## Troubleshooting

**Q: Redoc not loading**
A: Ensure Redoc script is loaded: `<script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>`

**Q: Sidebar is empty**
A: Check OpenAPI spec has tags defined in paths

**Q: Deep-linking not working**
A: Ensure URL parameter format: `?operationId=operationId`

**Q: Styles not applying**
A: Verify CSS modules are imported correctly

## Next Steps

1. Read full [README.md](./README.md) for complete API reference
2. Check [INTEGRATION_EXAMPLES.tsx](./INTEGRATION_EXAMPLES.tsx) for 10 examples
3. See [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) for technical details

## Files

| File | Purpose |
|------|---------|
| `RedocWrapper.tsx` | Standalone Redoc component |
| `ApiReferencePage.tsx` | Full-featured page |
| `useApiReference.ts` | React hook |
| `specUtils.ts` | OpenAPI utilities |
| `sidebarGenerator.ts` | Sidebar generation |
| `*.module.css` | Component styles |
| `README.md` | Full documentation |
| `INTEGRATION_EXAMPLES.tsx` | 10 examples |

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile browsers

## Support

For more help:
- Read [README.md](./README.md)
- Check [INTEGRATION_EXAMPLES.tsx](./INTEGRATION_EXAMPLES.tsx)
- See [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md)
- Review TypeScript type definitions

---

**Ready to get started?** Copy the 30-second setup above! 🚀
