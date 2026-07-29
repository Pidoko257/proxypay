/**
 * useApiReference Hook
 * 
 * Custom React hook for managing API reference state, including:
 * - Spec loading and caching
 * - Sidebar state
 * - Search/filter
 * - Deep-linking
 * - Keyboard shortcuts
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  fetchOpenAPISpec,
  extractTags,
  searchOperations,
  getOperation,
  type ApiOperation,
} from './specUtils';
import {
  generateApiSidebarFromSpec,
  filterSidebarItems,
  type SidebarItem,
} from './sidebarGenerator';

/**
 * Hook options
 */
export interface UseApiReferenceOptions {
  specUrl: string;
  baseUrl?: string;
  enableKeyboardShortcuts?: boolean;
  enableSearch?: boolean;
  onOperationSelect?: (operationId: string) => void;
}

/**
 * Hook return value
 */
export interface UseApiReferenceReturn {
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
  tags: Array<{ name: string; description?: string }>;

  // Actions
  setIsSidebarOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  selectOperation: (operationId: string) => void;
  refreshSpec: () => Promise<void>;
  clearSearch: () => void;
  exportSpec: () => void;
}

/**
 * Custom hook for API reference management
 */
export function useApiReference(options: UseApiReferenceOptions): UseApiReferenceReturn {
  const {
    specUrl,
    baseUrl = '/docs/api',
    enableKeyboardShortcuts = true,
    enableSearch = true,
    onOperationSelect,
  } = options;

  const location = useLocation();
  const navigate = useNavigate();

  // State
  const [spec, setSpec] = useState<Record<string, any> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth > 768);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentOperationId, setCurrentOperationId] = useState<string | null>(null);
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [filteredSidebarItems, setFilteredSidebarItems] = useState<SidebarItem[]>([]);
  const [tags, setTags] = useState<Array<{ name: string; description?: string }>>([]);

  // Refs
  const loadingRef = useRef(false);

  /**
   * Load spec
   */
  const loadSpec = useCallback(async (skipCache = false) => {
    if (loadingRef.current) return;

    try {
      loadingRef.current = true;
      setIsLoading(true);
      setError(null);

      const loadedSpec = await fetchOpenAPISpec(specUrl, { skipCache });
      setSpec(loadedSpec);

      // Generate sidebar and tags
      const sidebar = generateApiSidebarFromSpec(loadedSpec, baseUrl);
      setSidebarItems(sidebar);
      setFilteredSidebarItems(sidebar);

      const extractedTags = extractTags(loadedSpec);
      setTags(extractedTags);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to load API spec: ${message}`);
      console.error('Spec error:', err);
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, [specUrl, baseUrl]);

  /**
   * Refresh spec with cache bypass
   */
  const refreshSpec = useCallback(() => loadSpec(true), [loadSpec]);

  /**
   * Handle search/filter
   */
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);

      if (!query.trim() || !spec) {
        setFilteredSidebarItems(sidebarItems);
        return;
      }

      // Search operations
      const results = searchOperations(spec, query);
      const resultIds = new Set(results.map((r) => r.operationId));

      // Filter sidebar to only show matching operations
      const filtered = filterSidebarItems(sidebarItems, query);
      setFilteredSidebarItems(filtered);
    },
    [sidebarItems, spec]
  );

  /**
   * Select operation
   */
  const selectOperation = useCallback(
    (operationId: string) => {
      setCurrentOperationId(operationId);

      if (spec) {
        const operation = getOperation(spec, operationId);
        if (operation) {
          onOperationSelect?.(operationId);
          navigate(`?operationId=${operationId}`, { replace: true });
        }
      }

      // Close sidebar on mobile
      if (window.innerWidth < 768) {
        setIsSidebarOpen(false);
      }
    },
    [spec, navigate, onOperationSelect]
  );

  /**
   * Clear search
   */
  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setFilteredSidebarItems(sidebarItems);
  }, [sidebarItems]);

  /**
   * Export spec as JSON
   */
  const exportSpec = useCallback(() => {
    if (!spec) return;

    const json = JSON.stringify(spec, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = 'openapi-spec.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [spec]);

  /**
   * Load spec on mount and when specUrl changes
   */
  useEffect(() => {
    loadSpec();
  }, [specUrl, loadSpec]);

  /**
   * Handle URL search params for deep linking
   */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const operationId = params.get('operationId');

    if (operationId && operationId !== currentOperationId) {
      setCurrentOperationId(operationId);
      onOperationSelect?.(operationId);
    }
  }, [location.search, currentOperationId, onOperationSelect]);

  /**
   * Handle keyboard shortcuts
   */
  useEffect(() => {
    if (!enableKeyboardShortcuts) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Ctrl+K / Cmd+K to focus search
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        const searchInput = document.querySelector('[aria-label="Search API endpoints"]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }

      // Escape to close sidebar
      if (event.key === 'Escape' && isSidebarOpen) {
        event.preventDefault();
        setIsSidebarOpen(false);
      }

      // ? to show help
      if (event.key === '?' && !event.ctrlKey && !event.metaKey) {
        const target = event.target as HTMLElement;
        if (!target.matches('input, textarea, [contenteditable]')) {
          event.preventDefault();
          // Could show help modal here
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enableKeyboardShortcuts, isSidebarOpen]);

  /**
   * Handle window resize for sidebar responsiveness
   */
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 768 && !isSidebarOpen) {
        setIsSidebarOpen(true);
      } else if (window.innerWidth <= 768 && isSidebarOpen) {
        setIsSidebarOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isSidebarOpen]);

  // Get selected operation
  const selectedOperation = spec && currentOperationId ? getOperation(spec, currentOperationId) : null;

  return {
    // State
    spec,
    isLoading,
    error,
    isSidebarOpen,
    searchQuery,
    currentOperationId,
    selectedOperation,
    sidebarItems,
    filteredSidebarItems,
    tags,

    // Actions
    setIsSidebarOpen,
    setSearchQuery: handleSearch,
    selectOperation,
    refreshSpec,
    clearSearch,
    exportSpec,
  };
}

export default useApiReference;
