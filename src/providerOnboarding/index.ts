/**
 * Public surface for the Provider Onboarding Workflow.
 *
 * Importing this module registers the builtin providers (MTN, Airtel,
 * Orange, Mock) into the adapterSpec registry as a side effect, and
 * re-exports the rest of the onboarding API so callers can do:
 *
 *   import {
 *     credentialManager,
 *     checklistManager,
 *     healthCheckSetup,
 *     runSandboxTests,
 *   } from "../providerOnboarding";
 */

export * from "./adapterSpec";
export * from "./credentialManager";
export * from "./capabilityProbe";
export * from "./checklist";
export * from "./healthCheckSetup";
export * from "./sandboxTest";

// Side-effect: register built-in adapters on import.
import "./builtinAdapters";
