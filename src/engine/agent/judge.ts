/**
 * The judges: the reflex model behind ReflexJudge (one structured call per closed bar, every finalist at once) and
 * the deep model behind DeepJudge (escalations and the nightly review). They only judge; code decides.
 */
import type { ZodType } from "zod";
import type { LlmUsage } from "../ports";
import type { BriefContext, CallStatus, Finalist, ReflexDecision, ReflexInput } from "./types";
import { notImplemented } from "./notImplemented";

export type { BriefContext };

export interface ReflexRequest { input: ReflexInput; finalists: Finalist[]; brief: BriefContext | null; guidance: string; signal?: AbortSignal }
export interface ReflexResponse { status: CallStatus; decisions: ReflexDecision[]; dropped: string[]; usage: LlmUsage | null; model: string; latencyMs: number; error: string | null }
export interface ReflexJudge { readonly kind: "claude" | "fake"; readonly model: string; judge(req: ReflexRequest): Promise<ReflexResponse> }

export interface DeepRequest<T> { system: string; user: string; effort: "low" | "medium" | "high"; maxTokens: number; timeoutMs: number; schema: ZodType<T>; signal?: AbortSignal }
export interface DeepResponse<T> { status: CallStatus; parsed: T | null; usage: LlmUsage | null; model: string; latencyMs: number; error: string | null }
export interface DeepJudge { readonly model: string; structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>> }

export interface ClaudeJudgeOptions { apiKey: string; model: string; fetch?: typeof fetch; now?: () => number }

export class ClaudeReflexJudge implements ReflexJudge {
  readonly kind = "claude" as const;
  readonly model: string;

  constructor(private readonly o: ClaudeJudgeOptions) {
    this.model = o.model;
  }

  judge(req: ReflexRequest): Promise<ReflexResponse> {
    return notImplemented(this.o, req);
  }
}

export class ClaudeDeepJudge implements DeepJudge {
  readonly model: string;

  constructor(private readonly o: ClaudeJudgeOptions) {
    this.model = o.model;
  }

  structured<T>(req: DeepRequest<T>): Promise<DeepResponse<T>> {
    return notImplemented(this.o, req);
  }
}
