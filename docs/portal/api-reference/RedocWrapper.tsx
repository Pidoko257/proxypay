/**
 * Redoc API Reference Viewer
 * 
 * React wrapper for Redoc with:
 * - Deep-linking to specific endpoints
 * - Custom theme support
 * - Mobile responsive design
 * - Keyboard navigation
 * - Search integration
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import styles from './RedocWrapper.module.css';

declare const Redoc: any;

/**
 * Props for the Redoc wrapper component
 */
export interface RedocWrapperProps {
  /** URL to the OpenAPI spec (JSON or YAML) */
  specUrl: string;
  /** Optional title for the API reference */
  title?: string;
  /** Custom theme configuration */
  theme?: Record<string, any>;
  /** Enable/disable search functionality */
  enableSearch?: boolean;
  /** Deep link target (e.g., "operation/getTransactions") */
  deepLink?: string;
  /** Callback when spec is loaded */
  onSpecLoaded?: (spec: Record<string, any>) => void;
  /** Callback on navigation/deep-link */
  onNavigate?: (deepLink: string) => void;
  /** Custom className */
  className?: string;
  /** Show loading indicator */
  showLoader?: boolean;
  /** Disable native scroll behavior */
  disableScroll?: boolean;
}

/**
 * RedocWrapper Component
 * 
 * Renders Redoc API reference with deep-linking, theme customization,
 * and responsive design. Handles scroll positioning and keyboard navigation.
 */
export const RedocWrapper: React.FC<RedocWrapperProps> = ({
  specUrl,
  title = 'API Reference',
  theme,
  enableSearch = true,
  deepLink,
  onSpecLoaded,
  onNavigate,
  className = '',
  showLoader = true,
  disableScroll = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spec, setSpec] = useState<Record<string, any> | null>(null);
  const [currentDeepLink, setCurrentDeepLink] = useState<string | null>(deepLink || null);
  
  const location = useLocation();
  const navigate = useNavigate();

  /**
   * Fetch and parse OpenAPI spec
   */
  const loadSpec = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(specUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, application/yaml',
        },
        cache: 'force-cache',
      });

      if (!response.ok) {
        throw new Error(`Failed to load spec: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      let loadedSpec: Record<string, any>;

      if (contentType?.includes('yaml')) {
        // For YAML, we'd need to parse it (requires yaml library)
        const text = await response.text();
        console.warn('YAML support requires additional library. Using JSON only.');
        loadedSpec = JSON.parse(text);
      } else {
        loadedSpec = await response.json();
      }

      setSpec(loadedSpec);
      onSpecLoaded?.(loadedSpec);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to load API specification: ${message}`);
      console.error('Spec loading error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [specUrl, onSpecLoaded]);

  /**
   * Initialize Redoc with spec
   */
  useEffect(() => {
    loadSpec();
  }, [loadSpec, specUrl]);

  /**
   * Setup Redoc rendering when spec is loaded
   */
  useEffect(() => {
    if (!spec || !containerRef.current) return;

    // Default theme configuration
    const defaultTheme = {
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
        responses: {
          success: {
            color: '#28a745',
          },
        },
      },
      typography: {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
        fontSize: {
          base: '14px',
          big: '16px',
          code: '13px',
          title: '20px',
          heading1: '26px',
          heading2: '20px',
          heading3: '16px',
        },
      },
      logo: {
        margin: '0 0 1rem 0',
      },
      sidebar: {
        width: '260px',
        textColor: '#333333',
        activeTextColor: '#007bff',
        backgroundColor: '#f5f5f5',
        borderColor: '#e0e0e0',
      },
      codeBlock: {
        backgroundColor: '#f5f5f5',
        textColor: '#333333',
      },
      ...theme,
    };

    try {
      // Render Redoc into container
      if (window.Redoc) {
        window.Redoc.init(
          spec,
          {
            theme: defaultTheme,
            scrollYOffset: 60, // Offset for fixed header
            hideDownloadButton: false,
            hideHostname: false,
            suppressWarnings: true,
            pathInMiddlePanel: true,
            expandSingleSchemaField: true,
            expandDefaultServerVariables: true,
            disableSearch: !enableSearch,
            hideSchemas: false,
            hideInfo: false,
            hideSchemaSections: false,
            hideLoading: false,
            onDidLoad: () => {
              // Handle deep link after Redoc is loaded
              if (deepLink) {
                handleDeepLink(deepLink);
              }
            },
          },
          containerRef.current,
        );
      } else {
        setError('Redoc library not loaded');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to render API reference: ${message}`);
      console.error('Redoc rendering error:', err);
    }
  }, [spec, enableSearch, deepLink, theme]);

  /**
   * Handle deep linking to specific operations/sections
   */
  const handleDeepLink = useCallback((link: string) => {
    setCurrentDeepLink(link);
    onNavigate?.(link);

    // Parse deep link and scroll to element
    // Deep link format: "tag/operation-id" or "operation/operation-id"
    const parts = link.split('/');
    const targetId = parts.length > 1 ? parts[parts.length - 1] : link;

    // Try to find and scroll to the element
    if (!disableScroll) {
      const element = document.getElementById(targetId) || 
                     document.querySelector(`[data-operation-id="${targetId}"]`) ||
                     document.querySelector(`[data-tag="${targetId}"]`);

      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    // Update URL
    navigate(`?operationId=${targetId}`, { replace: true });
  }, [navigate, onNavigate, disableScroll]);

  /**
   * Handle URL search params for deep linking
   */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const operationId = params.get('operationId');

    if (operationId && operationId !== currentDeepLink) {
      handleDeepLink(operationId);
    }
  }, [location.search, currentDeepLink, handleDeepLink]);

  /**
   * Keyboard navigation
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ctrl+F or Cmd+F for search (if Redoc has search)
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        // Redoc handles search natively
      }

      // Escape to close mobile sidebar
      if (event.key === 'Escape') {
        // Redoc handles this natively
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Render loading state
  if (isLoading && showLoader) {
    return (
      <div className={`${styles.container} ${className}`} ref={containerRef}>
        <div className={styles.loader}>
          <div className={styles.spinner} />
          <p>Loading API reference...</p>
        </div>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className={`${styles.container} ${className}`} ref={containerRef}>
        <div className={styles.error}>
          <h2>⚠️ Failed to Load API Reference</h2>
          <p>{error}</p>
          <button onClick={() => loadSpec()} className={styles.retryButton}>
            🔄 Retry
          </button>
          <details className={styles.details}>
            <summary>Debug Info</summary>
            <code>
              Spec URL: {specUrl}
              <br />
              Current location: {location.pathname}
            </code>
          </details>
        </div>
      </div>
    );
  }

  // Render Redoc container
  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${className}`}
      data-testid="redoc-container"
      role="main"
      aria-label={title}
    >
      {/* Redoc will render here */}
    </div>
  );
};

RedocWrapper.displayName = 'RedocWrapper';

export default RedocWrapper;
