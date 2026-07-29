/**
 * API Sidebar Structure Generator
 * 
 * Generates sidebar navigation structure from OpenAPI spec,
 * organized by tags and operations, with deep-linking support.
 */

/**
 * Sidebar item structure
 */
export interface SidebarItem {
  id: string;
  label: string;
  href?: string;
  icon?: string;
  children?: SidebarItem[];
  level: number;
  type: 'tag' | 'operation' | 'section';
  metadata?: {
    operationId?: string;
    method?: string;
    path?: string;
    deprecated?: boolean;
    tags?: string[];
  };
}

/**
 * Sidebar structure for docs
 */
export interface DocsaurusSidebarConfig {
  [key: string]: {
    [key: string]: SidebarItem | SidebarItem[];
  };
}

/**
 * Generate sidebar items from OpenAPI spec
 */
export function generateApiSidebarFromSpec(
  spec: Record<string, any>,
  baseUrl: string = '/docs/api'
): SidebarItem[] {
  const tags = spec.tags || [];
  const paths = spec.paths || {};
  const sidebarItems: SidebarItem[] = [];

  // Group operations by tag
  const operationsByTag: Record<string, Array<{ path: string; method: string; operation: any }>> = {};

  for (const [path, pathItem] of Object.entries(paths)) {
    const methods = pathItem as Record<string, any>;

    for (const [method, operation] of Object.entries(methods)) {
      if (!isHttpMethod(method)) continue;

      const op = operation as Record<string, any>;
      const operationTags = op.tags || ['Other'];

      for (const tag of operationTags) {
        if (!operationsByTag[tag]) {
          operationsByTag[tag] = [];
        }
        operationsByTag[tag].push({
          path,
          method,
          operation: op,
        });
      }
    }
  }

  // Create sidebar items for each tag
  for (const tag of tags) {
    const tagName = tag.name;
    const tagOperations = operationsByTag[tagName] || [];

    // Sort operations by path and method
    tagOperations.sort((a, b) => {
      if (a.path !== b.path) {
        return a.path.localeCompare(b.path);
      }
      return getMethodOrder(a.method) - getMethodOrder(b.method);
    });

    // Create tag item
    const tagItem: SidebarItem = {
      id: `tag-${sanitizeId(tagName)}`,
      label: tagName,
      type: 'tag',
      level: 0,
      icon: getTagIcon(tagName),
      metadata: {
        tags: [tagName],
      },
      children: tagOperations.map((op, idx) => ({
        id: `${sanitizeId(tagName)}-${getMethodShort(op.method)}-${sanitizeId(op.path)}`,
        label: `${getMethodBadge(op.method)} ${op.operation.summary || op.path}`,
        href: `${baseUrl}?operationId=${op.operation.operationId || `${op.method}_${op.path}`}`,
        type: 'operation',
        level: 1,
        metadata: {
          operationId: op.operation.operationId,
          method: op.method,
          path: op.path,
          deprecated: op.operation.deprecated,
          tags: [tagName],
        },
      })),
    };

    if (tagItem.children && tagItem.children.length > 0) {
      sidebarItems.push(tagItem);
    }
  }

  // Add operations that aren't in any tag
  const uncategorizedOps = operationsByTag['Other'] || [];
  if (uncategorizedOps.length > 0) {
    const uncategorized: SidebarItem = {
      id: 'tag-uncategorized',
      label: 'Other',
      type: 'tag',
      level: 0,
      icon: '📚',
      children: uncategorizedOps.map((op) => ({
        id: `uncategorized-${getMethodShort(op.method)}-${sanitizeId(op.path)}`,
        label: `${getMethodBadge(op.method)} ${op.operation.summary || op.path}`,
        href: `${baseUrl}?operationId=${op.operation.operationId || `${op.method}_${op.path}`}`,
        type: 'operation',
        level: 1,
        metadata: {
          operationId: op.operation.operationId,
          method: op.method,
          path: op.path,
          deprecated: op.operation.deprecated,
        },
      })),
    };
    sidebarItems.push(uncategorized);
  }

  return sidebarItems;
}

/**
 * Convert sidebar items to Docusaurus format
 */
export function convertToDocusaurusSidebar(
  apiItems: SidebarItem[],
  sectionLabel: string = 'API Reference'
): Record<string, any> {
  const docsSidebar: Record<string, any> = {};

  const apiSection = apiItems.map((tag) => {
    if (!tag.children || tag.children.length === 0) {
      return null;
    }

    return {
      type: 'category',
      label: tag.label,
      collapsible: true,
      collapsed: true,
      items: tag.children.map((op) => ({
        type: 'link',
        label: op.label,
        href: op.href,
        className: op.metadata?.deprecated ? 'api-deprecated' : '',
      })),
    };
  }).filter(Boolean);

  return {
    docs: [
      {
        type: 'doc',
        id: 'intro',
      },
      {
        type: 'category',
        label: sectionLabel,
        collapsible: true,
        collapsed: false,
        items: apiSection,
      },
    ],
  };
}

/**
 * Generate search index from sidebar items
 */
export function generateSearchIndex(
  sidebarItems: SidebarItem[],
  spec: Record<string, any>
): Array<{
  id: string;
  title: string;
  description: string;
  url: string;
  method?: string;
  tags?: string[];
  operationId?: string;
}> {
  const index: Array<any> = [];

  for (const tag of sidebarItems) {
    // Add tag to index
    index.push({
      id: tag.id,
      title: tag.label,
      description: `${tag.label} API endpoints`,
      url: `/docs/api#${tag.id}`,
      tags: [tag.label],
    });

    // Add operations to index
    if (tag.children) {
      for (const op of tag.children) {
        const metadata = op.metadata;
        const summary = op.label.replace(getMethodRegex(metadata?.method || ''), '').trim();

        index.push({
          id: op.id,
          title: `${metadata?.method?.toUpperCase()} ${metadata?.path}`,
          description: summary,
          url: op.href,
          method: metadata?.method,
          operationId: metadata?.operationId,
          tags: metadata?.tags,
        });
      }
    }
  }

  return index;
}

/**
 * Generate breadcrumb navigation
 */
export function generateBreadcrumbs(
  sidebarItems: SidebarItem[],
  currentOperationId: string
): Array<{ label: string; href?: string }> {
  const breadcrumbs: Array<{ label: string; href?: string }> = [];

  for (const tag of sidebarItems) {
    if (tag.children) {
      for (const op of tag.children) {
        if (op.metadata?.operationId === currentOperationId) {
          breadcrumbs.push({ label: 'API' });
          breadcrumbs.push({ label: tag.label, href: `/docs/api#${tag.id}` });
          breadcrumbs.push({ label: op.label });
          return breadcrumbs;
        }
      }
    }
  }

  return [{ label: 'API' }];
}

/**
 * Filter sidebar items by search query
 */
export function filterSidebarItems(
  items: SidebarItem[],
  query: string
): SidebarItem[] {
  const lowerQuery = query.toLowerCase();

  return items
    .map((tag) => {
      if (!tag.children) return tag;

      const filteredChildren = tag.children.filter(
        (op) =>
          op.label.toLowerCase().includes(lowerQuery) ||
          op.metadata?.path?.toLowerCase().includes(lowerQuery) ||
          op.metadata?.operationId?.toLowerCase().includes(lowerQuery)
      );

      if (filteredChildren.length === 0) {
        return null;
      }

      return {
        ...tag,
        children: filteredChildren,
      };
    })
    .filter((tag) => tag !== null) as SidebarItem[];
}

/**
 * Generate table of contents for current operation
 */
export function generateOperationToc(operation: Record<string, any>): Array<{
  level: number;
  title: string;
  id: string;
}> {
  const toc: Array<{ level: number; title: string; id: string }> = [];

  // Description
  if (operation.description) {
    toc.push({
      level: 1,
      title: 'Overview',
      id: 'overview',
    });
  }

  // Parameters
  if (operation.parameters && operation.parameters.length > 0) {
    toc.push({
      level: 1,
      title: 'Parameters',
      id: 'parameters',
    });
  }

  // Request Body
  if (operation.requestBody) {
    toc.push({
      level: 1,
      title: 'Request Body',
      id: 'request-body',
    });
  }

  // Responses
  if (operation.responses && Object.keys(operation.responses).length > 0) {
    toc.push({
      level: 1,
      title: 'Responses',
      id: 'responses',
    });

    // Add response codes as sub-items
    for (const [code] of Object.entries(operation.responses)) {
      toc.push({
        level: 2,
        title: `${code}`,
        id: `response-${code}`,
      });
    }
  }

  // Security
  if (operation.security) {
    toc.push({
      level: 1,
      title: 'Security',
      id: 'security',
    });
  }

  // Code Examples
  toc.push({
    level: 1,
    title: 'Examples',
    id: 'examples',
  });

  return toc;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if string is an HTTP method
 */
function isHttpMethod(method: string): boolean {
  return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method.toLowerCase());
}

/**
 * Get HTTP method order for sorting
 */
function getMethodOrder(method: string): number {
  const order: Record<string, number> = {
    'get': 0,
    'post': 1,
    'put': 2,
    'patch': 3,
    'delete': 4,
    'options': 5,
    'head': 6,
  };
  return order[method.toLowerCase()] || 999;
}

/**
 * Get short method name
 */
function getMethodShort(method: string): string {
  return method.substring(0, 3).toUpperCase();
}

/**
 * Get method badge emoji
 */
function getMethodBadge(method: string): string {
  const badges: Record<string, string> = {
    'get': '🔍',
    'post': '✏️',
    'put': '🔄',
    'patch': '🔧',
    'delete': '🗑️',
    'options': '⚙️',
    'head': '📋',
  };
  return badges[method.toLowerCase()] || '📌';
}

/**
 * Get method regex for extraction
 */
function getMethodRegex(method: string): RegExp {
  return new RegExp(`^[${getMethodBadge(method)}]\\s+`, 'i');
}

/**
 * Get tag icon based on tag name
 */
function getTagIcon(tagName: string): string {
  const icons: Record<string, string> = {
    'auth': '🔐',
    'transactions': '💸',
    'vaults': '🏦',
    'contacts': '👥',
    'fees': '💰',
    'kyc': '🆔',
    'prices': '📊',
    'webhooks': '🔔',
    'security': '🔒',
    'admin': '⚙️',
  };

  const lower = tagName.toLowerCase();
  for (const [key, icon] of Object.entries(icons)) {
    if (lower.includes(key)) {
      return icon;
    }
  }

  return '📚';
}

/**
 * Sanitize string to valid ID
 */
function sanitizeId(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

export default {
  generateApiSidebarFromSpec,
  convertToDocusaurusSidebar,
  generateSearchIndex,
  generateBreadcrumbs,
  filterSidebarItems,
  generateOperationToc,
};
