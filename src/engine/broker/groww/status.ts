/** Groww order status strings mapped to the engine's order lifecycle. */
import type { OrderStatus } from "../../types";

/** Statuses that can still fill (doc examples also use OPEN/PENDING). */
const OPEN = new Set(["NEW", "ACKED", "TRIGGER_PENDING", "APPROVED", "MODIFICATION_REQUESTED", "CANCELLATION_REQUESTED", "OPEN", "PENDING"]);
const DONE = new Set(["EXECUTED", "COMPLETED", "DELIVERY_AWAITED"]);
const DEAD = new Set(["REJECTED", "FAILED"]);

export function mapGrowwStatus(status: string | null | undefined, filledQty: number, qty: number): OrderStatus {
  const s = (status ?? "").toUpperCase();
  if (DONE.has(s)) return filledQty > 0 && filledQty < qty ? "PARTIAL" : "FILLED";
  if (s === "CANCELLED") return "CANCELLED";
  if (DEAD.has(s)) return filledQty > 0 ? "CANCELLED" : "REJECTED";
  if (OPEN.has(s)) return filledQty > 0 ? "PARTIAL" : "OPEN";
  if (filledQty >= qty && qty > 0) return "FILLED";
  return "UNKNOWN";
}
