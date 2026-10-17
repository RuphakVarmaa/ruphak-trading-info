import { describe, expect, it } from "vitest";
import { ticketsUrl } from "./useIndexActions";

describe("ticketsUrl", () => {
  it("polls main's and the followers' copy tickets for the day", () => {
    expect(ticketsUrl("2026-10-16", "main")).toBe("/api/engine/copy?date=2026-10-16");
    expect(ticketsUrl("2026-10-16", "small10k")).toBe("/api/engine/copy?date=2026-10-16&account=small10k");
    expect(ticketsUrl(null, "small10k")).toBeNull();
  });
  it("never polls the agent's account: the engine refuses its copy tickets", () => {
    expect(ticketsUrl("2026-10-16", "agent")).toBeNull();
  });
});
