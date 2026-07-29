import { useState, useEffect, useCallback, useRef } from 'react';

export interface SearchResult {
  id: string;
  title: string;
  description: string;
  category: 'docs' | 'api' | 'guides' | 'code';
  url: string;
  icon?: string;
  tags?: string[];
  highlighted?: string;
}

export interface SearchIndexEntry {
  id: string;
  title: string;
  description: string;
  category: SearchResult['category'];
  url: string;
  icon?: string;
  tags?: string[];
  searchText: string; // Combined searchable text
}

interface UseGlobalSearchOptions {
  index: SearchIndexEntry[];
  debounceMs?: number;
  maxResults?: number;
}

/**
 * Hook for managing global search state and keyboard shortcuts
 * Provides search functionality with Cmd+K/Ctrl+K shortcut
 */
export function useGlobalSearch({
  index,
  debounceMs = 200,
  maxResults = 10,
}: UseGlobalSearchOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const debounceTimerRef = useRef<NodeJS.Timeout>();

  /**
   * Perform search based on query
   */
  const performSearch = useCallback(
    (searchQuery: string) => {
      if (!searchQuery.trim()) {
        setResults([]);
        setSelectedIndex(0);
        return;
      }

      setIsLoading(true);
      const queryLower = searchQuery.toLowerCase();

      // Simple search algorithm: score based on matches
      const scored = index.map((entry) => {
        const searchTextLower = entry.searchText.toLowerCase();
        const titleLower = entry.title.toLowerCase();

        let score = 0;
        let highlighted = '';

        // Exact title match gets highest score
        if (titleLower === queryLower) {
          score += 1000;
        } else if (titleLower.includes(queryLower)) {
          score += 500;
          highlighted = entry.title;
        } else if (searchTextLower.includes(queryLower)) {
          score += 100;
        } else {
          // Check individual words
          const queryWords = queryLower.split(/\s+/);
          const matchedWords = queryWords.filter((word) =>
            searchTextLower.includes(word)
          );
          score = matchedWords.length * 50;
        }

        return { ...entry, score, highlighted };
      });

      // Filter and sort results
      const sorted = scored
        .filter((result) => result.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      const formattedResults: SearchResult[] = sorted.map((result) => ({
        id: result.id,
        title: result.title,
        description: result.description,
        category: result.category,
        url: result.url,
        icon: result.icon,
        tags: result.tags,
        highlighted: result.highlighted,
      }));

      setResults(formattedResults);
      setSelectedIndex(0);
      setIsLoading(false);
    },
    [index, maxResults]
  );

  /**
   * Debounced search handler
   */
  const handleQueryChange = useCallback(
    (newQuery: string) => {
      setQuery(newQuery);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        performSearch(newQuery);
      }, debounceMs);
    },
    [performSearch, debounceMs]
  );

  /**
   * Navigate through results with keyboard
   */
  const navigateResults = useCallback(
    (direction: 'up' | 'down') => {
      if (results.length === 0) return;

      setSelectedIndex((current) => {
        if (direction === 'down') {
          return (current + 1) % results.length;
        } else {
          return (current - 1 + results.length) % results.length;
        }
      });
    },
    [results.length]
  );

  /**
   * Get currently selected result
   */
  const getSelectedResult = useCallback(() => {
    return results[selectedIndex] || null;
  }, [results, selectedIndex]);

  /**
   * Handle keyboard shortcuts
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K or Ctrl+K to open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
        if (!isOpen) {
          setQuery('');
          setResults([]);
          setSelectedIndex(0);
        }
      }

      // Only handle navigation when search is open
      if (!isOpen) return;

      // Arrow keys for navigation
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateResults('down');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateResults('up');
      }

      // Enter to select
      else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = getSelectedResult();
        if (selected) {
          handleSelectResult(selected);
        }
      }

      // Escape to close
      else if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, navigateResults, getSelectedResult]);

  /**
   * Handle result selection
   */
  const handleSelectResult = useCallback((result: SearchResult) => {
    // Navigate to result URL
    window.location.href = result.url;
    setIsOpen(false);
    setQuery('');
  }, []);

  /**
   * Clear search state
   */
  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    setSelectedIndex(0);
  }, []);

  /**
   * Toggle search modal
   */
  const toggleSearch = useCallback(() => {
    setIsOpen((prev) => !prev);
    if (isOpen) {
      clearSearch();
    }
  }, [isOpen, clearSearch]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    // State
    isOpen,
    query,
    results,
    selectedIndex,
    isLoading,

    // Actions
    setIsOpen,
    handleQueryChange,
    handleSelectResult,
    toggleSearch,
    clearSearch,
    navigateResults,

    // Selectors
    getSelectedResult,
  };
}
