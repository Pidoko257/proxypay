import React, { useMemo } from 'react';
import { SearchResult } from '../hooks/useGlobalSearch';
import styles from './SearchResults.module.css';

interface SearchResultsProps {
  results: SearchResult[];
  selectedIndex: number;
  onSelectResult: (result: SearchResult) => void;
  query: string;
}

/**
 * SearchResults Component
 * Displays categorized search results with keyboard navigation support
 */
export const SearchResults: React.FC<SearchResultsProps> = ({
  results,
  selectedIndex,
  onSelectResult,
  query,
}) => {
  // Group results by category
  const categorizedResults = useMemo(() => {
    const grouped: Record<SearchResult['category'], SearchResult[]> = {
      docs: [],
      api: [],
      guides: [],
      code: [],
    };

    results.forEach((result) => {
      grouped[result.category].push(result);
    });

    return grouped;
  }, [results]);

  // Get category label and icon
  const getCategoryInfo = (category: SearchResult['category']) => {
    const info: Record<SearchResult['category'], { label: string; icon: string }> = {
      docs: { label: 'Documentation', icon: '📖' },
      api: { label: 'API Reference', icon: '🔗' },
      guides: { label: 'Guides & Examples', icon: '🎯' },
      code: { label: 'Code Examples', icon: '💻' },
    };
    return info[category];
  };

  // Highlight query in text
  const highlightQuery = (text: string, query: string) => {
    if (!query) return text;

    const regex = new RegExp(`(${query})`, 'gi');
    const parts = text.split(regex);

    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className={styles.highlight}>
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  // Render category section
  const renderCategory = (
    category: SearchResult['category'],
    categoryResults: SearchResult[]
  ) => {
    if (categoryResults.length === 0) return null;

    const { label, icon } = getCategoryInfo(category);

    return (
      <div key={category} className={styles.category}>
        <div className={styles.categoryHeader}>
          <span className={styles.categoryIcon}>{icon}</span>
          <span className={styles.categoryLabel}>{label}</span>
          <span className={styles.categoryCount}>{categoryResults.length}</span>
        </div>

        <div className={styles.categoryItems}>
          {categoryResults.map((result, idx) => {
            // Calculate overall index
            const overallIndex = results.indexOf(result);
            const isSelected = overallIndex === selectedIndex;

            return (
              <button
                key={result.id}
                id={`search-result-${result.id}`}
                className={`${styles.resultItem} ${
                  isSelected ? styles.selected : ''
                }`}
                onClick={() => onSelectResult(result)}
                onMouseEnter={() => {
                  // Could add hover feedback here
                }}
                aria-selected={isSelected}
                role="option"
              >
                {/* Icon */}
                {result.icon && (
                  <span className={styles.resultIcon}>{result.icon}</span>
                )}

                {/* Content */}
                <div className={styles.resultContent}>
                  <div className={styles.resultTitle}>
                    {highlightQuery(result.title, query)}
                  </div>
                  <div className={styles.resultDescription}>
                    {highlightQuery(result.description, query)}
                  </div>

                  {/* Tags */}
                  {result.tags && result.tags.length > 0 && (
                    <div className={styles.resultTags}>
                      {result.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className={styles.tag}>
                          {tag}
                        </span>
                      ))}
                      {result.tags.length > 3 && (
                        <span className={styles.tagMore}>
                          +{result.tags.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Arrow indicator for selected */}
                {isSelected && (
                  <span className={styles.selectedIndicator}>→</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  // Build results list in order of priority
  const categoryOrder: Array<SearchResult['category']> = [
    'docs',
    'api',
    'guides',
    'code',
  ];

  return (
    <div className={styles.results} id="search-results" role="listbox">
      {categoryOrder.map((category) =>
        renderCategory(category, categorizedResults[category])
      )}
    </div>
  );
};
