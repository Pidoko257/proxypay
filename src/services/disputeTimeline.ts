/**
 * DisputeTimelineService
 *
 * Enriches raw dispute_timeline rows with human-readable labels, icon names,
 * phase groupings, and visual step metadata for frontend timeline rendering.
 *
 * Phases:
 *   - opening      : Dispute created and initial submission events
 *   - investigation: Evidence uploads, notes, agent assignment, status moves
 *                    to "investigating"
 *   - resolution   : Final status transitions (resolved, rejected, reversed,
 *                    upheld)
 */

import {
  DisputeModel,
  DisputeTimelineEvent,
} from "../models/dispute";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Enriched types
// ---------------------------------------------------------------------------

export interface EnrichedTimelineEvent extends DisputeTimelineEvent {
  /** Human-readable label for this event */
  label: string;
  /** Icon identifier for UI rendering */
  icon: string;
  /** Lifecycle phase this event belongs to */
  phase: "opening" | "investigation" | "resolution";
  /** Whether this event represents a status change */
  isStatusChange: boolean;
}

export interface TimelinePhaseGroup {
  phase: "opening" | "investigation" | "resolution";
  label: string;
  events: EnrichedTimelineEvent[];
}

export interface VisualTimeline {
  disputeId: string;
  totalEvents: number;
  phases: TimelinePhaseGroup[];
  /** Flat ordered list for simple list rendering */
  events: EnrichedTimelineEvent[];
}

// ---------------------------------------------------------------------------
// Static mapping tables
// ---------------------------------------------------------------------------

/** Maps event_type → { label, icon } */
const EVENT_TYPE_MAP: Record<string, { label: string; icon: string }> = {
  // Lifecycle
  opened:               { label: "Dispute opened",              icon: "opened" },
  status_changed:       { label: "Status updated",              icon: "status_changed" },
  assigned:             { label: "Assigned to agent",           icon: "assigned" },
  resolved:             { label: "Dispute resolved",            icon: "resolved" },
  rejected:             { label: "Dispute rejected",            icon: "rejected" },
  reversed:             { label: "Payment reversed",            icon: "reversed" },
  upheld:               { label: "Payment upheld",              icon: "upheld" },
  // Notes & evidence
  note_added:           { label: "Note added",                  icon: "note_added" },
  evidence_uploaded:    { label: "Evidence uploaded",           icon: "evidence_uploaded" },
  // Compliance & admin
  sla_warning:          { label: "SLA warning sent",            icon: "sla_warning" },
  sla_breach:           { label: "SLA breached",                icon: "sla_breach" },
  priority_changed:     { label: "Priority changed",            icon: "priority_changed" },
  category_changed:     { label: "Category changed",            icon: "category_changed" },
  // Manual / generic
  manual_note:          { label: "Manual note",                 icon: "note_added" },
  comment:              { label: "Comment added",               icon: "note_added" },
};

/** Status values that mark the resolution phase */
const RESOLUTION_STATUSES = new Set([
  "resolved",
  "rejected",
  "reversed",
  "upheld",
]);

/** Status values that mark the investigation phase */
const INVESTIGATION_STATUSES = new Set(["investigating"]);

/** Event types that always belong to a specific phase regardless of status */
const PHASE_OVERRIDES: Record<string, "opening" | "investigation" | "resolution"> = {
  opened:    "opening",
  resolved:  "resolution",
  rejected:  "resolution",
  reversed:  "resolution",
  upheld:    "resolution",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLabel(event: DisputeTimelineEvent): string {
  const base =
    EVENT_TYPE_MAP[event.eventType]?.label ??
    event.eventType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  if (event.oldStatus && event.newStatus) {
    return `${base}: ${event.oldStatus} → ${event.newStatus}`;
  }
  if (event.newStatus) {
    return `${base}: → ${event.newStatus}`;
  }
  if (event.description) {
    // Append a truncated description for clarity
    const snippet =
      event.description.length > 60
        ? `${event.description.slice(0, 57)}…`
        : event.description;
    return `${base} — ${snippet}`;
  }
  return base;
}

function buildIcon(event: DisputeTimelineEvent): string {
  return EVENT_TYPE_MAP[event.eventType]?.icon ?? event.eventType;
}

function resolvePhase(
  event: DisputeTimelineEvent,
): "opening" | "investigation" | "resolution" {
  // Hard-coded overrides take precedence
  if (PHASE_OVERRIDES[event.eventType]) {
    return PHASE_OVERRIDES[event.eventType];
  }

  // Resolution-bound status transitions
  if (event.newStatus && RESOLUTION_STATUSES.has(event.newStatus)) {
    return "resolution";
  }
  if (event.oldStatus && RESOLUTION_STATUSES.has(event.oldStatus)) {
    return "resolution";
  }

  // Investigation-bound events
  if (
    event.newStatus && INVESTIGATION_STATUSES.has(event.newStatus) ||
    event.eventType === "evidence_uploaded" ||
    event.eventType === "note_added" ||
    event.eventType === "assigned" ||
    event.eventType === "priority_changed" ||
    event.eventType === "category_changed" ||
    event.eventType === "sla_warning" ||
    event.eventType === "sla_breach"
  ) {
    return "investigation";
  }

  // Default: opening phase
  return "opening";
}

function enrichEvent(event: DisputeTimelineEvent): EnrichedTimelineEvent {
  return {
    ...event,
    label: buildLabel(event),
    icon: buildIcon(event),
    phase: resolvePhase(event),
    isStatusChange: Boolean(event.oldStatus || event.newStatus),
  };
}

const PHASE_LABELS: Record<"opening" | "investigation" | "resolution", string> =
  {
    opening:       "Dispute Opened",
    investigation: "Under Investigation",
    resolution:    "Resolution",
  };

const PHASE_ORDER: Array<"opening" | "investigation" | "resolution"> = [
  "opening",
  "investigation",
  "resolution",
];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DisputeTimelineService {
  private disputeModel = new DisputeModel();

  /**
   * Return the full enriched timeline for a dispute, grouped by phase.
   *
   * @param disputeId  UUID of the dispute.
   */
  async getTimeline(disputeId: string): Promise<VisualTimeline> {
    const details = await this.disputeModel.findByIdWithDetails(disputeId);
    if (!details) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    const enriched = details.timeline.map(enrichEvent);

    // Group by phase, preserving chronological order within each phase
    const grouped = new Map<
      "opening" | "investigation" | "resolution",
      EnrichedTimelineEvent[]
    >();
    for (const phase of PHASE_ORDER) {
      grouped.set(phase, []);
    }
    for (const ev of enriched) {
      grouped.get(ev.phase)!.push(ev);
    }

    const phases: TimelinePhaseGroup[] = PHASE_ORDER.filter(
      (p) => grouped.get(p)!.length > 0,
    ).map((p) => ({
      phase: p,
      label: PHASE_LABELS[p],
      events: grouped.get(p)!,
    }));

    return {
      disputeId,
      totalEvents: enriched.length,
      phases,
      events: enriched,
    };
  }

  /**
   * Add a timeline event and return the enriched form.
   *
   * @param disputeId   UUID of the dispute.
   * @param eventType   Machine-readable event type (e.g. 'note_added').
   * @param actor       Who triggered the event (user ID, agent name, 'system').
   * @param description Optional human-readable description.
   * @param oldStatus   Previous dispute status (for status-change events).
   * @param newStatus   New dispute status (for status-change events).
   * @param metadata    Arbitrary extra data to store with the event.
   */
  async addEvent(
    disputeId: string,
    eventType: string,
    actor: string,
    description?: string,
    oldStatus?: string,
    newStatus?: string,
    metadata?: Record<string, unknown>,
  ): Promise<EnrichedTimelineEvent> {
    // Verify the dispute exists
    const dispute = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    const raw = await this.disputeModel.addTimelineEvent(
      disputeId,
      eventType,
      actor,
      description,
      oldStatus,
      newStatus,
      metadata,
    );

    logger.info(
      { disputeId, eventType, actor, phase: resolvePhase(raw) },
      "Dispute timeline event added",
    );

    return enrichEvent(raw);
  }
}
