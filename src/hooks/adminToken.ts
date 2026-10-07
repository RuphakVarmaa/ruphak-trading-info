"use client";

/**
 * Admin token kept in sessionStorage['ruphak-admin-token'] (per tab, cleared when the tab
 * closes). Read through useSyncExternalStore so the server render and hydration see null.
 */
import { useSyncExternalStore } from "react";
import { EnvelopeError, fetchEnvelope } from "./engineFetch";

export const ADMIN_TOKEN_KEY = "ruphak-admin-token";

const listeners = new Set<() => void>();

function readToken(): string | null {
  try {
    return window.sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === ADMIN_TOKEN_KEY || e.key === null) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

const serverSnapshot = () => null;

export function useStoredAdminToken(): string | null {
  return useSyncExternalStore(subscribe, readToken, serverSnapshot);
}

export function storeAdminToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Storage blocked (private mode): the token simply isn't remembered.
  }
  listeners.forEach((l) => l());
}

export type VerifyResult = { ok: true } | { ok: false; code: string; error: string };

export async function verifyAdminToken(token: string): Promise<VerifyResult> {
  try {
    await fetchEnvelope<{ verified: boolean }>("/api/engine/admin/verify", { headers: { "x-admin-token": token } });
    return { ok: true };
  } catch (err) {
    if (err instanceof EnvelopeError) return { ok: false, code: err.code, error: err.message };
    return { ok: false, code: "ENGINE_UNREACHABLE", error: String(err) };
  }
}
