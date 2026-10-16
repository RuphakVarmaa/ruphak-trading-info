/** The body of an approve-or-reject request for the agent's candidate guidance (validated before the engine sees it). */
import type { Parsed } from "../../_lib/params";
import { fail } from "../../_lib/respond";

/** A candidate id as the engine issues it. */
const CANDIDATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseCandidateDecision(body: Record<string, unknown>): Parsed<{ id: string; decision: "approve" | "reject" }> {
  const { id, decision } = body;
  if (typeof id !== "string" || !CANDIDATE_ID.test(id)) return { ok: false, response: fail("BAD_REQUEST", "'id' must be a candidate id: letters, digits, '-' or '_', at most 64.") };
  if (decision !== "approve" && decision !== "reject") return { ok: false, response: fail("BAD_REQUEST", "'decision' must be 'approve' or 'reject'.") };
  return { ok: true, value: { id, decision } };
}
