/**
 * API Reference Module - Barrel Exports
 * 
 * Complete API reference implementation with:
 * - Redoc integration
 * - Sidebar navigation
 * - Search and filtering
 * - Deep-linking
 * - Custom hooks and utilities
 */

// Main components
export { RedocWrapper, type RedocWrapperProps } from './RedocWrapper';
export { ApiReferencePage, type ApiReferencePageProps } from './ApiReferencePage';

// Hook
export { useApiReference, type UseApiReferenceOptions, type UseApiReferenceReturn } from './useApiReference';

// Utilities
export {
  fetchOpenAPISpec,
  extractMetadata,
  extractTags,
  extractOperationsByTag,
  extractAllOperations,
  searchOperations,
  getOperation,
  generateCodeExample,
  clearSpecCache,
  getSpecCacheStats,
  preloadSpec,
  exportSpec,
  type SpecMetadata,
  type ApiTag,
  type ApiOperation,
} from './specUtils';

// Sidebar generation
export {
  generateApiSidebarFromSpec,
  convertToDocusaurusSidebar,
  generateSearchIndex,
  generateBreadcrumbs,
  filterSidebarItems,
  generateOperationToc,
  type SidebarItem,
  type DocsaurusSidebarConfig,
} from './sidebarGenerator';

export default {
  RedocWrapper,
  ApiReferencePage,
  useApiReference,
};
