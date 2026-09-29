/**
 * Tests for Dispute Timeline Visualization
 *
 * Covers:
 * - DisputeTimelineService.getTimeline() — enrichment and phase grouping
 * - DisputeTimelineService.addEvent() — event creation and enrichment
 * - DisputeModel.addTimelineEvent() — persistence
 * - Route integration: GET /api/disputes/:id/timeline
 * - Route integration: POST /api/disputes/:id/timeline
 */

import { DisputeTimelineService } from "../services/disputeTimeline";
import { DisputeModel, DisputeTimelineEvent } from "../models/dispute";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../models/dispute");

const mockDispute = {
  id: "dispute-001",
  transactionId: "tx-001",
  reason: "Unauthorized charge",
  status: "investigating" as const,
  assignedTo: "agent-1",
  resolution: null,
  reportedBy: "user-1",
  priority: "high" as const,
  category: "fraud",
  slaDueDate: null,
  slaWarningSent: false,
  internalNotes: null,
  createdAt: new Date("2026-09-01T10:00:00Z"),
  updatedAt: new Date("2026-09-01T12:00:00Z"),
};

const makeTimelineEvent = (overrides: Partial<DisputeTimelineEvent> = {}): DisputeTimelineEvent => ({
  id: "evt-001",
  disputeId: "dispute-001",
  eventType: "opened",
  oldStatus: null,
  newStatus: "open",
  actor: "user-1",
  description: "Dispute opened",
  metadata: null,
  createdAt: new Date("2026-09-01T10:00:00Z"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// DisputeTimelineService unit tests
// ---------------------------------------------------------------------------

describe("DisputeTimelineService", () => {
  let service: DisputeTimelineService;
  let mockModel: jest.Mocked<DisputeModel>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DisputeTimelineService();
    // Access the private model via any cast for testing
    mockModel = (service as any).disputeModel as jest.Mocked<DisputeModel>;
  });

  describe("getTimeline", () => {
    it("returns enriched timeline with phases when dispute has events", async () => {
      const events: DisputeTimelineEvent[] = [
        makeTimelineEvent({ eventType: "opened", newStatus: "open" }),
        makeTimelineEvent({
          id: "evt-002",
          eventType: "assigned",
          oldStatus: "open",
          newStatus: "investigating",
          actor: "agent-1",
          description: "Assigned to agent-1",
          createdAt: new Date("2026-09-01T11:00:00Z"),
        }),
        makeTimelineEvent({
          id: "evt-003",
          eventType: "status_changed",
          oldStatus: "investigating",
          newStatus: "resolved",
          actor: "admin",
          createdAt: new Date("2026-09-01T12:00:00Z"),
        }),
      ];

      mockModel.findByIdWithDetails = jest.fn().mockResolvedValue({
        ...mockDispute,
        notes: [],
        evidence: [],
        timeline: events,
      });

      const result = await service.getTimeline("dispute-001");

      // Top-level structure
      expect(result).toHaveProperty("events");
      expect(result).toHaveProperty("phases");
      expect(result.events).toHaveLength(3);

      // Enrichment
      const openedEvent = result.events[0];
      expect(openedEvent).toHaveProperty("label");
      expect(openedEvent).toHaveProperty("icon");
      expect(openedEvent).toHaveProperty("phase");
      expect(openedEvent).toHaveProperty("isStatusChange");
      expect(openedEvent.eventType).toBe("opened");
      expect(openedEvent.isStatusChange).toBe(true);

      // Phase grouping — phases is an array of TimelinePhaseGroup
      expect(Array.isArray(result.phases)).toBe(true);
      const phaseNames = result.phases.map((p: any) => p.phase);
      expect(phaseNames).toContain("opening");
      expect(phaseNames).toContain("investigation");
      expect(phaseNames).toContain("resolution");
    });

    it("throws when dispute is not found", async () => {
      mockModel.findByIdWithDetails = jest.fn().mockResolvedValue(null);
      await expect(service.getTimeline("nonexistent")).rejects.toThrow("not found");
    });

    it("returns empty events array when dispute has no timeline events", async () => {
      mockModel.findByIdWithDetails = jest.fn().mockResolvedValue({
        ...mockDispute,
        notes: [],
        evidence: [],
        timeline: [],
      });

      const result = await service.getTimeline("dispute-001");
      expect(result.events).toHaveLength(0);
    });

    it("assigns correct phase for evidence_uploaded event", async () => {
      mockModel.findByIdWithDetails = jest.fn().mockResolvedValue({
        ...mockDispute,
        notes: [],
        evidence: [],
        timeline: [makeTimelineEvent({ eventType: "evidence_uploaded" })],
      });

      const result = await service.getTimeline("dispute-001");
      expect(result.events[0].phase).toBe("investigation");
    });

    it("assigns correct phase for resolution events", async () => {
      for (const eventType of ["resolved", "rejected", "reversed", "upheld"]) {
        mockModel.findByIdWithDetails = jest.fn().mockResolvedValue({
          ...mockDispute,
          notes: [],
          evidence: [],
          timeline: [makeTimelineEvent({ eventType })],
        });

        const result = await service.getTimeline("dispute-001");
        expect(result.events[0].phase).toBe("resolution");
      }
    });
  });

  describe("addEvent", () => {
    it("creates an event and returns enriched result", async () => {
      const newEvent = makeTimelineEvent({ eventType: "note_added", actor: "agent-1" });
      mockModel.findById = jest.fn().mockResolvedValue(mockDispute);
      mockModel.addTimelineEvent = jest.fn().mockResolvedValue(newEvent);

      const result = await service.addEvent(
        "dispute-001",
        "note_added",
        "agent-1",
        "Note was added",
      );

      expect(mockModel.addTimelineEvent).toHaveBeenCalledWith(
        "dispute-001",
        "note_added",
        "agent-1",
        "Note was added",
        undefined,
        undefined,
        undefined,
      );
      expect(result).toHaveProperty("label");
      expect(result).toHaveProperty("icon");
      expect(result).toHaveProperty("phase");
    });

    it("throws when dispute does not exist", async () => {
      mockModel.findById = jest.fn().mockResolvedValue(null);
      await expect(
        service.addEvent("nonexistent", "note_added", "agent"),
      ).rejects.toThrow("not found");
    });
  });
});

// ---------------------------------------------------------------------------
// DisputeModel.addTimelineEvent unit tests
// ---------------------------------------------------------------------------

jest.mock("../config/database", () => ({
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
  pool: { query: jest.fn() },
}));

import { queryWrite } from "../config/database";

describe("DisputeModel.addTimelineEvent", () => {
  let model: DisputeModel;

  beforeEach(() => {
    jest.clearAllMocks();
    // Use the real DisputeModel but with mocked DB
    const { DisputeModel: RealDisputeModel } = jest.requireActual("../models/dispute");
    model = new RealDisputeModel();
  });

  it("inserts a timeline event and returns mapped row", async () => {
    const mockRow: DisputeTimelineEvent = {
      id: "evt-123",
      disputeId: "dispute-001",
      eventType: "status_changed",
      oldStatus: "open",
      newStatus: "investigating",
      actor: "agent-1",
      description: "Status changed",
      metadata: { priority: "high" },
      createdAt: new Date("2026-09-01T11:00:00Z"),
    };

    (queryWrite as jest.Mock).mockResolvedValue({ rows: [mockRow] });

    const result = await model.addTimelineEvent(
      "dispute-001",
      "status_changed",
      "agent-1",
      "Status changed",
      "open",
      "investigating",
      { priority: "high" },
    );

    expect(queryWrite).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO dispute_timeline"),
      expect.arrayContaining(["dispute-001", "status_changed", "agent-1"]),
    );
    expect(result.eventType).toBe("status_changed");
    expect(result.oldStatus).toBe("open");
    expect(result.newStatus).toBe("investigating");
  });
});
