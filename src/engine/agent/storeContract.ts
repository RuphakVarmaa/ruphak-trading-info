/**
 * The behaviour every AgentStore must show, as a vitest describe block: MemoryAgentStore and the worker's
 * SqlAgentStore both run it (the pattern of src/engine/repo/contract.ts).
 */
import type { AgentStore } from "./types";
import { notImplemented } from "./notImplemented";

export function agentStoreContract(name: string, make: () => Promise<AgentStore>): void {
  notImplemented(name, make);
}
