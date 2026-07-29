import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useGlobalSearch } from '../hooks/useGlobalSearch';
import { SearchModal } from '../components/SearchModal';
import { SearchResults } from '../components/SearchResults';
import { generateFullSearchIndex } from '../utils/generateSearchIndex';

// Mock data
const mockIndex = [
  {
    id: 'docs-getting-started',
    title: 'Getting Started',
    description: 'Learn how to get started with the platform',
    category: 'docs' as const,
    url: '/docs/getting-started',
    searchText: 'getting started learn how to get started with the platform',
  },
  {
    id: 'api-post-transactions',
    title: 'Create Transaction',
    description: 'Create a new transaction via API',
    category: 'api' as const,
    url: '/api/post/transactions',
    icon: '✍️',
    tags: ['transactions', 'create'],
    searchText: 'post transactions create a new transaction via api',
  },
  {
    id: 'guide-example-deposit',
    title: 'Example: Simple Deposit',
    description: 'A simple example of how to deposit funds',
    category: 'guides' as const,
    url: '/guides/example-deposit',
    tags: ['deposit', 'example'],
    searchText: 'example simple deposit a simple example of how to deposit funds',
  },
];

describe('useGlobalSearch Hook', () => {
  it('should initialize with empty state', () => {
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex })
    );

    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe('');
    expect(result.current.results).toEqual([]);
  });

  it('should open and close search modal', () => {
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex })
    );

    act(() => {
      result.current.toggleSearch();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.toggleSearch();
    });
    expect(result.current.isOpen).toBe(false);
  });

  it('should search and filter results', () => {
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex })
    );

    act(() => {
      result.current.handleQueryChange('transaction');
    });

    expect(result.current.results.length).toBeGreaterThan(0);
    expect(result.current.results[0].title).toContain('Transaction');
  });

  it('should navigate through results with keyboard', () => {
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex })
    );

    act(() => {
      result.current.handleQueryChange('example');
    });

    const initialIndex = result.current.selectedIndex;

    act(() => {
      result.current.navigateResults('down');
    });
    expect(result.current.selectedIndex).not.toBe(initialIndex);

    act(() => {
      result.current.navigateResults('up');
    });
    expect(result.current.selectedIndex).toBe(initialIndex);
  });

  it('should handle Cmd+K keyboard shortcut', () => {
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex })
    );

    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });

    expect(result.current.isOpen).toBe(true);
  });

  it('should handle Ctrl+K keyboard shortcut', () => {
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex })
    );

    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });

    expect(result.current.isOpen).toBe(true);
  });

  it('should clear search state', () => {
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex })
    );

    act(() => {
      result.current.handleQueryChange('test');
    });
    expect(result.current.query).toBe('test');

    act(() => {
      result.current.clearSearch();
    });
    expect(result.current.query).toBe('');
    expect(result.current.results).toEqual([]);
  });

  it('should debounce search queries', async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() =>
      useGlobalSearch({ index: mockIndex, debounceMs: 300 })
    );

    act(() => {
      result.current.handleQueryChange('t');
    });
    expect(result.current.results).toEqual([]);

    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(result.current.results).toEqual([]);

    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(result.current.results.length).toBeGreaterThan(0);

    jest.useRealTimers();
  });

  it('should respect maxResults limit', () => {
    const largeIndex = Array.from({ length: 50 }, (_, i) => ({
      id: `doc-${i}`,
      title: `Document ${i}`,
      description: 'Test document',
      category: 'docs' as const,
      url: `/docs/${i}`,
      searchText: 'test document',
    }));

    const { result } = renderHook(() =>
      useGlobalSearch({ index: largeIndex, maxResults: 10 })
    );

    act(() => {
      result.current.handleQueryChange('document');
    });

    expect(result.current.results.length).toBeLessThanOrEqual(10);
  });
});

describe('SearchModal Component', () => {
  it('should not render when not open', () => {
    render(
      <SearchModal index={mockIndex} isOpen={false} onClose={() => {}} />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('should render when open', () => {
    render(
      <SearchModal index={mockIndex} isOpen={true} onClose={() => {}} />
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('should focus input when opened', async () => {
    const { rerender } = render(
      <SearchModal index={mockIndex} isOpen={false} onClose={() => {}} />
    );

    rerender(
      <SearchModal index={mockIndex} isOpen={true} onClose={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search/i)).toHaveFocus();
    });
  });

  it('should close when clicking backdrop', () => {
    const onClose = jest.fn();
    render(
      <SearchModal index={mockIndex} isOpen={true} onClose={onClose} />
    );

    const backdrop = screen.getByRole('dialog').parentElement;
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });

  it('should search when typing', async () => {
    render(
      <SearchModal index={mockIndex} isOpen={true} onClose={() => {}} />
    );

    const input = screen.getByPlaceholderText(/search/i);
    await userEvent.type(input, 'transaction');

    await waitFor(() => {
      expect(screen.getByText('Create Transaction')).toBeInTheDocument();
    });
  });

  it('should display keyboard hints', () => {
    render(
      <SearchModal index={mockIndex} isOpen={true} onClose={() => {}} />
    );

    expect(screen.getByText(/↑↓ to navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/Enter to select/i)).toBeInTheDocument();
    expect(screen.getByText(/Esc to close/i)).toBeInTheDocument();
  });

  it('should show empty state when no results', async () => {
    render(
      <SearchModal index={mockIndex} isOpen={true} onClose={() => {}} />
    );

    const input = screen.getByPlaceholderText(/search/i);
    await userEvent.type(input, 'nonexistentterm');

    await waitFor(() => {
      expect(screen.getByText(/No results found/i)).toBeInTheDocument();
    });
  });
});

describe('SearchResults Component', () => {
  it('should categorize results', () => {
    render(
      <SearchResults
        results={mockIndex}
        selectedIndex={0}
        onSelectResult={() => {}}
        query="example"
      />
    );

    expect(screen.getByText('Documentation')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
    expect(screen.getByText('Guides & Examples')).toBeInTheDocument();
  });

  it('should highlight selected result', () => {
    const { container } = render(
      <SearchResults
        results={mockIndex}
        selectedIndex={1}
        onSelectResult={() => {}}
        query=""
      />
    );

    const selectedElement = container.querySelector('.selected');
    expect(selectedElement).toBeInTheDocument();
  });

  it('should display tags', () => {
    render(
      <SearchResults
        results={[mockIndex[1]]}
        selectedIndex={0}
        onSelectResult={() => {}}
        query=""
      />
    );

    expect(screen.getByText('transactions')).toBeInTheDocument();
    expect(screen.getByText('create')).toBeInTheDocument();
  });

  it('should call onSelectResult when result is clicked', () => {
    const onSelect = jest.fn();
    render(
      <SearchResults
        results={[mockIndex[0]]}
        selectedIndex={0}
        onSelectResult={onSelect}
        query=""
      />
    );

    fireEvent.click(screen.getByText('Getting Started'));
    expect(onSelect).toHaveBeenCalledWith(mockIndex[0]);
  });

  it('should highlight query in results', () => {
    const { container } = render(
      <SearchResults
        results={[mockIndex[0]]}
        selectedIndex={0}
        onSelectResult={() => {}}
        query="started"
      />
    );

    const highlights = container.querySelectorAll('mark');
    expect(highlights.length).toBeGreaterThan(0);
  });
});

describe('Search Index Generation', () => {
  it('should generate API index from OpenAPI schema', () => {
    const openApiSchema = {
      paths: {
        '/api/transactions': {
          get: {
            summary: 'List transactions',
            description: 'Get all transactions',
            tags: ['Transactions'],
          },
          post: {
            summary: 'Create transaction',
            description: 'Create a new transaction',
            tags: ['Transactions'],
          },
        },
      },
    };

    const index = generateAPIIndex(openApiSchema);

    expect(index.length).toBe(2);
    expect(index[0].category).toBe('api');
    expect(index[0].title).toContain('List transactions');
  });

  it('should categorize results correctly', () => {
    const fullIndex = generateFullSearchIndex(
      '/docs',
      {
        paths: {
          '/api/test': {
            get: {
              summary: 'Test endpoint',
              tags: [],
            },
          },
        },
      }
    );

    const docs = fullIndex.filter((e) => e.category === 'docs');
    const api = fullIndex.filter((e) => e.category === 'api');

    expect(docs.length + api.length).toBeGreaterThan(0);
  });
});

// Helper function for renderHook (would typically come from @testing-library/react)
function renderHook(hook: () => any) {
  let result: any;
  function HookComponent() {
    result = hook();
    return null;
  }
  render(<HookComponent />);
  return { result };
}

// Helper for act (would typically come from react)
function act(fn: () => void) {
  fn();
}
