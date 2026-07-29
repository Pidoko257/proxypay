import React, { useRef, useEffect } from 'react';
import { useGlobalSearch, SearchIndexEntry } from '../hooks/useGlobalSearch';
import { SearchResults } from './SearchResults';
import styles from './SearchModal.module.css';

interface SearchModalProps {
  index: SearchIndexEntry[];
  isOpen: boolean;
  onClose: () => void;
}

/**
 * SearchModal Component
 * Displays search interface with modal overlay and categorized results
 */
export const SearchModal: React.FC<SearchModalProps> = ({
  index,
  isOpen,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    query,
    results,
    selectedIndex,
    isLoading,
    handleQueryChange,
    handleSelectResult,
    clearSearch,
  } = useGlobalSearch({
    index,
    debounceMs: 200,
    maxResults: 15,
  });

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      // Use setTimeout to ensure focus happens after modal renders
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Handle click outside
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
      clearSearch();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className={styles.backdrop}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="search-modal-title"
    >
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.inputWrapper}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              placeholder="Search documentation, APIs, and guides..."
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              aria-label="Search documentation"
              aria-autocomplete="list"
              aria-controls="search-results"
              aria-expanded={results.length > 0}
              aria-activedescendant={
                results[selectedIndex]
                  ? `search-result-${results[selectedIndex].id}`
                  : undefined
              }
            />
            {query && (
              <button
                className={styles.clearButton}
                onClick={clearSearch}
                aria-label="Clear search"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          {/* Keyboard hints */}
          <div className={styles.hints}>
            <span className={styles.hint}>
              <kbd>↑↓</kbd> to navigate
            </span>
            <span className={styles.hint}>
              <kbd>Enter</kbd> to select
            </span>
            <span className={styles.hint}>
              <kbd>Esc</kbd> to close
            </span>
          </div>
        </div>

        {/* Results or Empty State */}
        <div className={styles.body}>
          {isLoading && (
            <div className={styles.loading}>
              <span className={styles.spinner}></span>
              Searching...
            </div>
          )}

          {!isLoading && results.length > 0 && (
            <SearchResults
              results={results}
              selectedIndex={selectedIndex}
              onSelectResult={handleSelectResult}
              query={query}
            />
          )}

          {!isLoading && query && results.length === 0 && (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>🔍</span>
              <p>No results found for "{query}"</p>
              <p className={styles.emptyHint}>
                Try searching for different keywords or browse by category
              </p>
            </div>
          )}

          {!query && results.length === 0 && !isLoading && (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>✨</span>
              <p>Search documentation, API references, and guides</p>
              <p className={styles.emptyHint}>
                Start typing to find what you need
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.stats}>
            {results.length > 0 && (
              <span className={styles.resultCount}>
                {selectedIndex + 1} / {results.length} results
              </span>
            )}
          </div>
          <div className={styles.powered}>
            Powered by global search
          </div>
        </div>
      </div>
    </div>
  );
};
