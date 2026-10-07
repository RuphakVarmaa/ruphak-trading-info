import type { NextResponse } from "next/server";
import { EVENT_TABS, type BacktestParams, type EngineMode, type EventTab, type KillSwitchRequest } from "@/engine/api-types";
import { isIsoDate } from "@/lib/ist";
import { fail } from "./respond";

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

const bad = (error: string): { ok: false; response: NextResponse } => ({ ok: false, response: fail("BAD_REQUEST", error) });
const good = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

/** Optional integer query parameter within [min, max]. */
export function intParam(sp: URLSearchParams, name: string, def: number, min: number, max: number): Parsed<number> {
  const raw = sp.get(name);
  if (raw == null || raw === "") return good(def);
  if (!/^-?\d+$/.test(raw)) return bad(`'${name}' must be an integer.`);
  const n = Number(raw);
  if (n < min || n > max) return bad(`'${name}' must be between ${min} and ${max}.`);
  return good(n);
}

export function tabParam(sp: URLSearchParams): Parsed<EventTab> {
  const raw = (sp.get("tab") ?? "ALL").toUpperCase();
  return (EVENT_TABS as readonly string[]).includes(raw) ? good(raw as EventTab) : bad(`'tab' must be one of ${EVENT_TABS.join(", ")}.`);
}

/** `since` as epoch ms or an ISO timestamp. */
export function sinceParam(sp: URLSearchParams): Parsed<number | undefined> {
  const raw = sp.get("since");
  if (raw == null || raw === "") return good(undefined);
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(n) ? good(n) : bad("'since' must be epoch milliseconds or an ISO timestamp.");
}

export function dateParam(sp: URLSearchParams, name: string, def: string): Parsed<string> {
  const raw = sp.get(name);
  if (raw == null || raw === "") return good(def);
  return isIsoDate(raw) ? good(raw) : bad(`'${name}' must be a date as YYYY-MM-DD.`);
}

export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const MAX_BODY_BYTES = 4096;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a small JSON object body; anything else is a 400. */
export async function jsonBody(req: Request): Promise<Parsed<Record<string, unknown>>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return bad("Could not read the request body.");
  }
  if (text.length > MAX_BODY_BYTES) return bad("Request body is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("Request body must be valid JSON.");
  }
  return isRecord(parsed) ? good(parsed) : bad("Request body must be a JSON object.");
}

export function parseArm(body: Record<string, unknown>): Parsed<{ armed: boolean }> {
  return typeof body.armed === "boolean" ? good({ armed: body.armed }) : bad("'armed' must be a boolean.");
}

export function parseKill(body: Record<string, unknown>): Parsed<KillSwitchRequest> {
  if (typeof body.engaged !== "boolean") return bad("'engaged' must be a boolean.");
  if (body.squareOff !== undefined && typeof body.squareOff !== "boolean") return bad("'squareOff' must be a boolean.");
  if (body.reason !== undefined && typeof body.reason !== "string") return bad("'reason' must be a string.");
  const reason = (typeof body.reason === "string" ? body.reason : "").trim();
  if (reason.length > 200) return bad("'reason' must be at most 200 characters.");
  return good({
    engaged: body.engaged,
    squareOff: body.engaged ? body.squareOff === true : false,
    reason: reason || (body.engaged ? "Manual kill from dashboard" : "Reset from dashboard"),
  });
}

export function parseMode(body: Record<string, unknown>): Parsed<{ mode: EngineMode }> {
  return body.mode === "PAPER" || body.mode === "LIVE" ? good({ mode: body.mode }) : bad("'mode' must be 'PAPER' or 'LIVE'.");
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseBacktest(body: Record<string, unknown>, todayIst: string): Parsed<BacktestParams> {
  const { from, to, index, thresholdDelta, stopPct, targetPct, noEvents } = body;
  if (typeof from !== "string" || !isIsoDate(from)) return bad("'from' must be a date as YYYY-MM-DD.");
  if (typeof to !== "string" || !isIsoDate(to)) return bad("'to' must be a date as YYYY-MM-DD.");
  if (from > to) return bad("'from' must not be after 'to'.");
  if (to > todayIst) return bad("'to' cannot be in the future.");
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > 731) return bad("The date range can span at most two years.");
  if (index !== "NIFTY" && index !== "SENSEX" && index !== "BOTH") return bad("'index' must be NIFTY, SENSEX or BOTH.");
  if (!finite(thresholdDelta) || thresholdDelta < -0.3 || thresholdDelta > 0.3) return bad("'thresholdDelta' must be a number between -0.3 and 0.3.");
  if (!finite(stopPct) || stopPct < -90 || stopPct > -5) return bad("'stopPct' must be a negative percent between -90 and -5.");
  if (!finite(targetPct) || targetPct < 5 || targetPct > 300) return bad("'targetPct' must be a percent between 5 and 300.");
  if (typeof noEvents !== "boolean") return bad("'noEvents' must be a boolean.");
  return good({ from, to, index, thresholdDelta, stopPct, targetPct, noEvents });
}
