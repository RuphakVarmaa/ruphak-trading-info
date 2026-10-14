/** A hand-built OptionFlowView for the flow helpers' tests (made-up values; never shown on a page). */
import type { FlowSide, OptionFlowView } from "@/engine/api-types";

export const side = (oiChg: number | null, ltpChgPct: number | null, buildup: FlowSide["buildup"], extra: Partial<FlowSide> = {}): FlowSide => ({
  oi: 1_000_000,
  oiChg,
  oiChgPct: oiChg == null ? null : (oiChg / 1_000_000) * 100,
  vol: 50_000,
  ltp: 120,
  ltpChgPct,
  ivChg: 0.1,
  buildup,
  ...extra,
});

const rows15 = [
  { strike: 22300, ce: side(5_000, -1, "SHORT_BUILDUP"), pe: side(-20_000, -4, "LONG_UNWINDING") },
  { strike: 22350, ce: side(10_000, -1, "SHORT_BUILDUP"), pe: side(30_000, -3, "SHORT_BUILDUP") },
  { strike: 22400, ce: side(-15_000, 2, "SHORT_COVERING"), pe: side(250_000, -5, "SHORT_BUILDUP") },
  { strike: 22450, ce: side(40_000, -2, "SHORT_BUILDUP"), pe: side(90_000, -2, "SHORT_BUILDUP") },
  { strike: 22500, ce: side(120_000, -3, "SHORT_BUILDUP"), pe: side(60_000, 1, "LONG_BUILDUP") },
  { strike: 22550, ce: side(310_000, -4, "SHORT_BUILDUP"), pe: side(-5_000, 0.1, "NEUTRAL") },
  { strike: 22600, ce: side(80_000, -2, "SHORT_BUILDUP"), pe: null },
  { strike: 23000, ce: side(900_000, -1, "SHORT_BUILDUP"), pe: side(null, null, "NEUTRAL") },
];

export const FLOW: OptionFlowView = {
  index: "NIFTY",
  asOf: "2026-10-14T10:42:05+05:30",
  spot: 22512.4,
  atm: 22500,
  windows: {
    "1m": { rows: rows15.map((r) => ({ ...r, ce: r.ce && { ...r.ce, vol: 9_000 }, pe: r.pe && { ...r.pe, vol: 600 } })) },
    "5m": { rows: rows15.map((r) => ({ ...r, ce: r.ce && { ...r.ce, vol: 20_000 }, pe: r.pe && { ...r.pe, vol: 3_000 } })) },
    "15m": { rows: rows15 },
  },
  events: [
    { at: "2026-10-14T10:40:00+05:30", index: "NIFTY", strike: 22550, side: "CE", kind: "SHORT_BUILDUP", text: "22550 CE: 3.1L OI added in 5 min while the price fell 4%", magnitude: 310_000 },
    { at: "2026-10-14T10:41:30+05:30", index: "NIFTY", strike: 22500, side: "CE", kind: "VOLUME_SPIKE", text: "22500 CE: volume ×4.2 normal", magnitude: 4.2 },
    { at: "2026-10-14T10:35:00+05:30", index: "NIFTY", strike: 22400, side: "PE", kind: "OI_WALL", text: "22400 PE: put wall", magnitude: 2_500_000 },
  ],
  summary: { callWritersVsPutWriters: 1.2, pcr: 0.94, pcrChg15m: -0.06, resistance: 22600, support: 22400, premiumDryUp: true, decayPctPerHourAtm: 6.4 },
  bestEntryWindow: { window: "09:45–11:15 IST", verdict: "good", reason: "Premium per point of expected move is lowest here (history)." },
  source: "feed",
  error: null,
};
