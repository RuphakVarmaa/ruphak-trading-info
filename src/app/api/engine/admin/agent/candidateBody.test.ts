import { describe, expect, it } from "vitest";
import { parseCandidateDecision } from "./candidateBody";

describe("the candidate decision body", () => {
  it("accepts an id with approve or reject", () => {
    expect(parseCandidateDecision({ id: "cand-2026-10-15", decision: "approve" })).toEqual({ ok: true, value: { id: "cand-2026-10-15", decision: "approve" } });
    expect(parseCandidateDecision({ id: "c_1", decision: "reject" })).toEqual({ ok: true, value: { id: "c_1", decision: "reject" } });
  });

  it("refuses a malformed id or any other decision with a 400", async () => {
    for (const body of [{ decision: "approve" }, { id: "a b", decision: "approve" }, { id: "x".repeat(65), decision: "approve" }, { id: 5, decision: "approve" }, { id: "c", decision: "APPROVE" }, { id: "c" }]) {
      const r = parseCandidateDecision(body);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        expect(await r.response.json()).toMatchObject({ ok: false, code: "BAD_REQUEST" });
      }
    }
  });
});
