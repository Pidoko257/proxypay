/**
 * API Reference Page Component
 * 
 * Complete page for displaying Redoc API reference with:
 * - Sidebar navigation with tags and operations
 * - Search/filter functionality
 * - Deep-linking to specific endpoints
 * - Responsive design
 * - Dark mode support
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { RedocWrapper, RedocWrapperProps } from './RedocWrapper';
import {
  fetchOpenAPISpec,
  extractMetadata,
  extractTags,
  searchOperations,
} from './specUtils';
import {
  generateApiSidebarFromSpec,
  filterSidebarItems,
  generateBreadcrumbs,
  SidebarItem,
} from './sidebarGenerator';
import styles from './ApiReferencePage.module.css';

/**
 * Props for API Reference Page
 */
export interface ApiReferencePageProps {
  /** URL to OpenAPI spec */
  specUrl: string;
  /** Base URL for deep-linking */
  baseUrl?: string;
  /** Custom title */
  title?: string;
  /** Custom theme */
  theme?: Record<string, any>;
  /** Show sidebar */
  showSidebar?: boolean;
  /** Show search */
  showSearch?: boolean;
  /** On navigation callback */
  onNavigate?: (operationId: string) => void;
}

/**
 * API Reference Page Component
 */
export const ApiReferencePage: React.FC<ApiReferencePageProps> = ({
  specUrl,
  baseUrl = '/docs/api',
  title = 'API Reference',
  theme,
  showSidebar = true,
  showSearch = true,
  onNavigate,
}) => {
  const [spec, setSpec] = useState<Record<string, any> | null>(null);
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [filteredSidebarItems, setFilteredSidebarItems] = useState<SidebarItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [currentOperationId, setCurrentOperationId] = useState<string | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  /**
   * Load and parse spec
   */
  useEffect(() => {
    const loadSpec = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const loadedSpec = await fetchOpenAPISpec(specUrl);
        setSpec(loadedSpec);

        // Generate sidebar from spec
        const sidebar = generateApiSidebarFromSpec(loadedSpec, baseUrl);
        setSidebarItems(sidebar);
        setFilteredSidebarItems(sidebar);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(`Failed to load API spec: ${message}`);
        console.error('Spec loading error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadSpec();
  }, [specUrl, baseUrl]);

  /**
   * Handle search/filter
   */
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);

      if (!query.trim()) {
        setFilteredSidebarItems(sidebarItems);
        return;
      }

      const filtered = filterSidebarItems(sidebarItems, query);
      setFilteredSidebarItems(filtered);
    },
    [sidebarItems]
  );

  /**
   * Handle operation selection
   */
  const handleOperationSelect = useCallback(
    (operationId: string) => {
      setCurrentOperationId(operationId);
      onNavigate?.(operationId);
      setIsSidebarOpen(false); // Close sidebar on mobile

      // Scroll to top on small screens
      if (window.innerWidth < 768) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [onNavigate]
  );

  /**
   * Extract deep link from URL
   */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const operationId = params.get('operationId');

    if (operationId) {
      setCurrentOperationId(operationId);
    }
  }, [location.search]);

  // Get metadata
  const metadata = useMemo(
    () => (spec ? extractMetadata(spec) : null),
    [spec]
  );

  // Get tags
  const tags = useMemo(() => (spec ? extractTags(spec) : []), [spec]);

  // Get breadcrumbs
  const breadcrumbs = useMemo(
    () => (currentOperationId ? generateBreadcrumbs(sidebarItems, currentOperationId) : []),
    [sidebarItems, currentOperationId]
  );

  if (error && !spec) {
    return (
      <div className={styles.container}>
        <div className={styles.errorContainer}>
          <h2>⚠️ Failed to Load API Reference</h2>
          <p>{error}</p>
          <button
            onClick={() => window.location.reload()}
            className={styles.retryButton}
          >
            🔄 Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <div className={styles.headerLeft}>
            {showSidebar && (
              <button
                className={styles.sidebarToggle}
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                aria-label="Toggle sidebar"
                title="Toggle sidebar (mobile)"
              >
                ☰
              </button>
            )}
            <h1 className={styles.headerTitle}>{title}</h1>
          </div>

          {showSearch && (
            <div className={styles.searchBox}>
              <input
                type="text"
                placeholder="Search endpoints..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                className={styles.searchInput}
                aria-label="Search API endpoints"
              />
              {searchQuery && (
                <button
                  onClick={() => handleSearch('')}
                  className={styles.searchClear}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main layout */}
      <div className={styles.layout}>
        {/* Sidebar */}
        {showSidebar && (
          <aside
            className={`${styles.sidebar} ${isSidebarOpen ? styles.sidebarOpen : ''}`}
          >
            <div className={styles.sidebarContent}>
              <div className={styles.sidebarHeader}>
                <h2>API Endpoints</h2>
                <button
                  className={styles.sidebarClose}
                  onClick={() => setIsSidebarOpen(false)}
                  aria-label="Close sidebar"
                  title="Close sidebar"
                >
                  ✕
                </button>
              </div>

              <nav className={styles.sidebarNav}>
                {filteredSidebarItems.length === 0 ? (
                  <div className={styles.sidebarEmpty}>
                    {searchQuery ? 'No endpoints match your search' : 'No endpoints found'}
                  </div>
                ) : (
                  filteredSidebarItems.map((tag) => (
                    <div key={tag.id} className={styles.tagGroup}>
                      <div className={styles.tagLabel}>
                        <span className={styles.tagIcon}>{tag.icon}</span>
                        <span>{tag.label}</span>
                      </div>

                      {tag.children && (
                        <ul className={styles.operationList}>
                          {tag.children.map((op) => (
                            <li key={op.id}>
                              <a
                                href={op.href || '#'}
                                onClick={(e) => {
                                  e.preventDefault();
                                  if (op.metadata?.operationId) {
                                    handleOperationSelect(op.metadata.operationId);
                                    navigate(op.href || '#');
                                  }
                                }}
                                className={`${styles.operationLink} ${
                                  currentOperationId === op.metadata?.operationId
                                    ? styles.operationLinkActive
                                    : ''
                                } ${op.metadata?.deprecated ? styles.operationLinkDeprecated : ''}`}
                                title={op.label}
                              >
                                <span className={styles.methodBadge}>
                                  {op.metadata?.method?.toUpperCase()}
                                </span>
                                <span className={styles.operationPath}>
                                  {op.metadata?.path || op.label}
                                </span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}
              </nav>

              {/* Info footer */}
              {metadata && (
                <div className={styles.sidebarFooter}>
                  <p className={styles.apiVersion}>
                    v{metadata.version}
                  </p>
                  {metadata.contact?.name && (
                    <p className={styles.apiContact}>
                      {metadata.contact.name}
                    </p>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Main content */}
        <main className={styles.main}>
          {/* Breadcrumbs */}
          {breadcrumbs.length > 0 && (
            <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
              {breadcrumbs.map((crumb, idx) => (
                <React.Fragment key={idx}>
                  {idx > 0 && <span className={styles.breadcrumbSeparator}>/</span>}
                  {crumb.href ? (
                    <a
                      href={crumb.href}
                      className={styles.breadcrumbLink}
                      onClick={() => setSearchQuery('')}
                    >
                      {crumb.label}
                    </a>
                  ) : (
                    <span className={styles.breadcrumbCurrent}>{crumb.label}</span>
                  )}
                </React.Fragment>
              ))}
            </nav>
          )}

          {/* Loading state */}
          {isLoading ? (
            <div className={styles.loadingContainer}>
              <div className={styles.spinner} />
              <p>Loading API documentation...</p>
            </div>
          ) : spec ? (
            <RedocWrapper
              specUrl={specUrl}
              title={metadata?.title || title}
              theme={theme}
              deepLink={currentOperationId || undefined}
              onNavigate={handleOperationSelect}
              enableSearch={showSearch}
              className={styles.redocContainer}
            />
          ) : null}
        </main>
      </div>

      {/* Overlay for mobile sidebar */}
      {isSidebarOpen && (
        <div
          className={styles.overlay}
          onClick={() => setIsSidebarOpen(false)}
          role="presentation"
        />
      )}
    </div>
  );
};

ApiReferencePage.displayName = 'ApiReferencePage';

export default ApiReferencePage;
