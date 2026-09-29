/**
 * ComplianceVersionService
 *
 * Business logic for compliance document version control:
 *  - Publishing a new version (update document + snapshot)
 *  - Retrieving version history
 *  - Restoring to a prior version
 *  - Comparing two versions field-by-field
 */

import {
  ComplianceDocumentModel,
  ComplianceDocumentVersion,
  ComplianceDocumentVersionCreateInput,
  ComplianceDocument,
} from "../models/complianceDocument";

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

type FieldDiff = {
  field: string;
  from: unknown;
  to: unknown;
  changed: boolean;
};

type VersionComparison = {
  documentId: string;
  v1: number;
  v2: number;
  diffs: FieldDiff[];
  hasChanges: boolean;
};

const VERSION_FIELDS: Array<keyof ComplianceDocumentVersion> = [
  "title",
  "summary",
  "body",
  "countryCode",
  "provider",
  "tags",
  "sourceUrl",
  "status",
  "changeSummary",
];

function fieldChanged(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

// ---------------------------------------------------------------------------
// Version history entry (version row + computed diff badge)
// ---------------------------------------------------------------------------

export interface VersionHistoryEntry extends ComplianceDocumentVersion {
  /** Human-readable summary of what changed relative to previous version. */
  diffBadge: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ComplianceVersionService {
  private readonly model: ComplianceDocumentModel;

  constructor(model?: ComplianceDocumentModel) {
    this.model = model ?? new ComplianceDocumentModel();
  }

  /**
   * Publish a new version of a compliance document.
   *
   * Steps:
   *  1. Apply the updated fields to the live document row.
   *  2. Snapshot the new state as a version record.
   *
   * Returns the updated live document and the newly created version.
   */
  async publishVersion(
    documentId: string,
    input: ComplianceDocumentVersionCreateInput,
    changeSummary: string,
    actorUserId?: string,
  ): Promise<{ document: ComplianceDocument; version: ComplianceDocumentVersion }> {
    const document = await this.model.update(
      documentId,
      {
        title: input.title,
        summary: input.summary,
        body: input.body,
        countryCode: input.countryCode,
        provider: input.provider,
        tags: input.tags,
        sourceUrl: input.sourceUrl,
        status: input.status as "draft" | "published" | "archived",
      },
      actorUserId,
    );

    if (!document) {
      throw new Error(`Compliance document not found: ${documentId}`);
    }

    const version = await this.model.createVersion(
      documentId,
      input,
      changeSummary,
      actorUserId,
    );

    return { document, version };
  }

  /**
   * Return all versions for a document with a diff badge describing what
   * changed relative to the immediately preceding version.
   */
  async getVersionHistory(documentId: string): Promise<VersionHistoryEntry[]> {
    const versions = await this.model.listVersions(documentId);

    return versions.map((version, index): VersionHistoryEntry => {
      const previous = versions[index + 1]; // versions are DESC, so [index+1] is older
      const diffBadge = previous
        ? this.buildDiffBadge(previous, version)
        : "Initial version";

      return { ...version, diffBadge };
    });
  }

  /**
   * Restore a document to a prior version state.
   * Creates a new version snapshot before overwriting so nothing is lost.
   *
   * Returns the restored live document.
   */
  async restoreVersion(
    documentId: string,
    versionNumber: number,
    actorUserId?: string,
  ): Promise<ComplianceDocument> {
    const restored = await this.model.restoreVersion(
      documentId,
      versionNumber,
      actorUserId,
    );

    if (!restored) {
      throw new Error(
        `Version ${versionNumber} not found for document ${documentId}`,
      );
    }

    return restored;
  }

  /**
   * Compare two specific versions of a document field-by-field.
   */
  async compareVersions(
    documentId: string,
    v1Number: number,
    v2Number: number,
  ): Promise<VersionComparison> {
    const [v1, v2] = await Promise.all([
      this.model.findVersion(documentId, v1Number),
      this.model.findVersion(documentId, v2Number),
    ]);

    if (!v1) {
      throw new Error(`Version ${v1Number} not found for document ${documentId}`);
    }
    if (!v2) {
      throw new Error(`Version ${v2Number} not found for document ${documentId}`);
    }

    const diffs: FieldDiff[] = VERSION_FIELDS.map((field) => {
      const from = v1[field];
      const to = v2[field];
      return { field, from, to, changed: fieldChanged(from, to) };
    });

    return {
      documentId,
      v1: v1Number,
      v2: v2Number,
      diffs,
      hasChanges: diffs.some((d) => d.changed),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildDiffBadge(
    older: ComplianceDocumentVersion,
    newer: ComplianceDocumentVersion,
  ): string {
    if (newer.changeSummary) {
      return newer.changeSummary;
    }

    const changedFields = VERSION_FIELDS.filter((f) =>
      fieldChanged(older[f], newer[f]),
    );

    if (changedFields.length === 0) {
      return "No content changes";
    }

    if (changedFields.length === 1) {
      return `Updated: ${changedFields[0]}`;
    }

    const listed = changedFields.slice(0, 3).join(", ");
    const extra = changedFields.length > 3 ? ` (+${changedFields.length - 3} more)` : "";
    return `Updated: ${listed}${extra}`;
  }
}

// Singleton export for convenience
export const complianceVersionService = new ComplianceVersionService();
