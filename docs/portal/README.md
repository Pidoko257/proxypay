# Global Search for Documentation Portal

A complete implementation of a global search bar for documentation portals with keyboard shortcuts (Cmd+K/Ctrl+K), categorized results, and accessibility features.

## Features

✅ **Keyboard Shortcuts** - Cmd+K or Ctrl+K to open search
✅ **Categorized Results** - Results organized by: Docs, API Reference, Guides, Code Examples
✅ **Keyboard Navigation** - Arrow keys to navigate, Enter to select, Esc to close
✅ **Real-time Search** - Debounced search with live result filtering
✅ **Accessibility** - Full ARIA labels, keyboard support, focus management
✅ **Dark Mode Support** - Automatically adapts to system preferences
✅ **Mobile Responsive** - Touch-friendly on mobile devices
✅ **Highlighting** - Query matches highlighted in results
✅ **Tags & Metadata** - Display relevant tags for each result
✅ **Empty States** - Helpful messages when no results found

## Components

### `useGlobalSearch` Hook
Manages search state and keyboard shortcuts. Powers all search functionality.

```typescript
const {
  isOpen,
  query,
  results,
  selectedIndex,
  isLoading,
  handleQueryChange,
  handleSelectResult,
  toggleSearch,
} = useGlobalSearch({
  index: searchIndex,
  debounceMs: 200,
  maxResults: 15,
});
```

### `SearchModal` Component
Modal overlay with search input and results display.

```tsx
<SearchModal
  index={searchIndex}
  isOpen={isOpen}
  onClose={() => setIsOpen(false)}
/>
```

### `SearchResults` Component
Displays categorized, keyboard-navigable search results.

```tsx
<SearchResults
  results={results}
  selectedIndex={selectedIndex}
  onSelectResult={handleSelectResult}
  query={query}
/>
```

## Search Index

### Building the Index

```typescript
import { generateFullSearchIndex, saveIndexToJSON } from './utils/generateSearchIndex';

const docsDir = './docs';
const openApiSchema = require('./api-schema.json');
const guideDir = './examples';

const index = generateFullSearchIndex(docsDir, openApiSchema, guideDir);
saveIndexToJSON(index, './public/data/search-index.json');
```

### Index Entry Structure

```typescript
interface SearchIndexEntry {
  id: string;                    // Unique identifier
  title: string;                 // Display title
  description: string;           // Short description
  category: 'docs' | 'api' | 'guides' | 'code';
  url: string;                   // Link to resource
  icon?: string;                 // Optional icon/emoji
  tags?: string[];              // Tags for categorization
  searchText: string;            // Full searchable text
}
```

## Usage Example

### 1. Setup Search Index

```typescript
// Generate search index from your documentation
import { generateFullSearchIndex, saveIndexToJSON } from '@/docs/portal/utils/generateSearchIndex';
import openApiSchema from '@/docs/api-schema.json';

const index = generateFullSearchIndex(
  './docs',
  openApiSchema,
  './examples'
);

saveIndexToJSON(index, './public/search-index.json');
```

### 2. Load and Use in Your App

```tsx
import { useEffect, useState } from 'react';
import { SearchModal } from '@/docs/portal/components/SearchModal';
import { useGlobalSearch } from '@/docs/portal/hooks/useGlobalSearch';

export function App() {
  const [searchIndex, setSearchIndex] = useState([]);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    // Load search index
    fetch('/search-index.json')
      .then((res) => res.json())
      .then(setSearchIndex);
  }, []);

  return (
    <>
      <SearchModal
        index={searchIndex}
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
      />
      
      {/* Rest of your app */}
    </>
  );
}
```

### 3. Add Search Trigger Button

```tsx
import { useGlobalSearch } from '@/docs/portal/hooks/useGlobalSearch';

export function Header() {
  const { toggleSearch } = useGlobalSearch({ index: searchIndex });

  return (
    <header>
      <button 
        onClick={() => toggleSearch()}
        className="search-button"
      >
        🔍 Search (Cmd+K)
      </button>
    </header>
  );
}
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` / `Ctrl+K` | Open/close search |
| `↑` / `↓` | Navigate results |
| `Enter` | Select highlighted result |
| `Esc` | Close search |
| `Backspace` | Clear search (in input) |

## Customization

### Styling

All components use CSS modules. Customize by editing:
- `components/SearchModal.module.css` - Main modal styling
- `components/SearchResults.module.css` - Results list styling

### Search Behavior

Adjust search parameters in `useGlobalSearch`:

```typescript
useGlobalSearch({
  index,
  debounceMs: 200,        // Debounce delay in ms
  maxResults: 15,         // Maximum results to show
})
```

### Result Categories

Modify categories in the index generator:

```typescript
const result: SearchIndexEntry = {
  // ...
  category: 'docs' | 'api' | 'guides' | 'code'
}
```

## Accessibility

The implementation includes:

- ✅ Full keyboard navigation
- ✅ ARIA labels for screen readers
- ✅ Focus management
- ✅ Semantic HTML
- ✅ Color contrast compliance
- ✅ Reduced motion support
- ✅ Lazy loading for performance

## Testing

Run the test suite:

```bash
npm test -- docs/portal/__tests__/search.test.tsx
```

Tests cover:
- Hook functionality
- Component rendering
- Keyboard interactions
- Search behavior
- Index generation
- Accessibility features

## Performance

- **Debounced Search**: Prevents excessive re-renders
- **Result Limiting**: Configurable max results
- **Lazy Index Loading**: Load index only when needed
- **Efficient Scoring**: Fast relevance-based filtering

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari 14+, Chrome Android)

## Dark Mode

Automatically detects system preference via `prefers-color-scheme` media query.

## Mobile Optimization

- Touch-friendly result items
- Full-screen modal on small screens
- Optimized keyboard for mobile
- Swipe to dismiss gesture support

## API Reference

### useGlobalSearch Hook

```typescript
interface UseGlobalSearchOptions {
  index: SearchIndexEntry[];
  debounceMs?: number;
  maxResults?: number;
}

function useGlobalSearch(options: UseGlobalSearchOptions): {
  // State
  isOpen: boolean;
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  isLoading: boolean;

  // Actions
  setIsOpen: (open: boolean) => void;
  handleQueryChange: (query: string) => void;
  handleSelectResult: (result: SearchResult) => void;
  toggleSearch: () => void;
  clearSearch: () => void;
  navigateResults: (direction: 'up' | 'down') => void;

  // Selectors
  getSelectedResult: () => SearchResult | null;
}
```

## Example Integration with Next.js

```typescript
// pages/index.tsx
import { useEffect, useState } from 'react';
import { SearchModal } from '@/docs/portal/components/SearchModal';
import { SearchIndexEntry } from '@/docs/portal/hooks/useGlobalSearch';

export default function Home() {
  const [index, setIndex] = useState<SearchIndexEntry[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  useEffect(() => {
    fetch('/api/search/index').then((r) => r.json()).then(setIndex);
  }, []);

  return (
    <>
      <SearchModal
        index={index}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
      {/* Your content */}
    </>
  );
}
```

## Troubleshooting

**Search modal won't open**
- Check that `Cmd+K` or `Ctrl+K` event is being captured
- Verify keyboard event listeners are attached to `window`

**Results not showing**
- Ensure search index is loaded correctly
- Check that `searchText` field in entries contains query
- Verify debounce timer is not causing delays

**Styling issues**
- Check CSS module imports are correct
- Verify dark mode preference in browser settings
- Clear browser cache

## License

MIT

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.
