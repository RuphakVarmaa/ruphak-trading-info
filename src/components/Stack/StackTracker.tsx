'use client';

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { C, pnlColor } from '@/components/shared/colors';
import { Btn, inputStyle, microLabel, StatTile, tableStyle, tableWrap, td, tdNum, th, theadRow, thNum } from '@/components/shared/ui';
import type { PricePoint, StackHolding } from '@/utils/api';
import { calculateStackSummary } from '@/utils/api';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Holdings live in localStorage, read through useSyncExternalStore: the server render and
// hydration see an empty list, then the stored holdings appear (no effect needed).
const STORAGE_KEY = 'ruphak-stack-holdings';
const EMPTY_HOLDINGS: StackHolding[] = [];
const holdingsListeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedHoldings: StackHolding[] = EMPTY_HOLDINGS;

function loadHoldings(): StackHolding[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch { raw = null; }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      cachedHoldings = Array.isArray(parsed) ? parsed : EMPTY_HOLDINGS;
    } catch { cachedHoldings = EMPTY_HOLDINGS; }
  }
  return cachedHoldings;
}

const serverHoldings = () => EMPTY_HOLDINGS;

function subscribeHoldings(cb: () => void) {
  holdingsListeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY || e.key === null) cb(); };
  window.addEventListener('storage', onStorage);
  return () => {
    holdingsListeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

function saveHoldings(holdings: StackHolding[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
  holdingsListeners.forEach((l) => l());
}

interface StackTrackerProps {
  /** US dollars per troy ounce by metal name; empty until the live prices load. */
  prices: PricePoint[];
}

export default function StackTracker({ prices }: StackTrackerProps) {
  const holdings = useSyncExternalStore(subscribeHoldings, loadHoldings, serverHoldings);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ metal: 'gold', type: 'bar', weight: '', weightUnit: 'oz' as const, purchasePrice: '', purchaseDate: '', notes: '' });

  const summary = calculateStackSummary(holdings, prices);
  // Without live prices the holdings have no value yet: show dashes, never $0.
  const priced = prices.length > 0 || holdings.length === 0;

  const addHolding = () => {
    if (!form.weight || !form.purchasePrice) return;
    const h: StackHolding = {
      id: generateId(),
      metal: form.metal,
      type: form.type,
      weight: parseFloat(form.weight),
      weightUnit: form.weightUnit,
      purchasePrice: parseFloat(form.purchasePrice),
      purchaseDate: form.purchaseDate || new Date().toISOString().split('T')[0],
      notes: form.notes,
    };
    saveHoldings([...holdings, h]);
    setForm({ metal: 'gold', type: 'bar', weight: '', weightUnit: 'oz', purchasePrice: '', purchaseDate: '', notes: '' });
    setShowForm(false);
  };

  const removeHolding = (id: string) => {
    saveHoldings(holdings.filter(h => h.id !== id));
  };

  const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const field = (label: string, control: ReactNode) => (
    <label style={{ display: 'block', minWidth: 0 }}>
      <span style={{ ...microLabel, display: 'block', marginBottom: 5 }}>{label}</span>
      {control}
    </label>
  );

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <StatTile label="Total value" value={priced ? money(summary.totalValueUsd) : '—'} color={C.textStrong} sub={priced ? undefined : 'waiting for live prices'} />
        <StatTile label="Cost basis" value={money(summary.totalCostBasis)} color={C.textSoft} />
        <StatTile label="Gain / loss" value={priced ? `${summary.totalGainLoss >= 0 ? '+' : ''}${money(summary.totalGainLoss)}` : '—'} color={priced ? pnlColor(summary.totalGainLoss) : C.muted} />
        <StatTile label="Return" value={priced ? `${summary.totalGainLossPercent >= 0 ? '+' : ''}${summary.totalGainLossPercent.toFixed(2)}%` : '—'} color={priced ? pnlColor(summary.totalGainLossPercent) : C.muted} />
      </div>

      {summary.holdings.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          {summary.holdings.map((h) => (
            <div key={h.metal} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.textStrong, marginBottom: 6 }}>{h.metal}</div>
              <div style={{ fontSize: 12, color: C.muted }}>{h.totalOz.toFixed(2)} oz</div>
              <div style={{ fontSize: 13, color: C.textStrong, fontFamily: 'var(--font-num)', marginTop: 2 }}>{priced ? money(h.totalValue) : '—'}</div>
              {priced && (
                <div style={{ fontSize: 12, color: pnlColor(h.gainLoss), fontFamily: 'var(--font-num)' }}>
                  {h.gainLoss >= 0 ? '+' : ''}
                  {h.gainLossPercent.toFixed(2)}%
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {holdings.length > 0 && (
        <div style={tableWrap}>
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={th}>Metal</th>
                <th style={th}>Type</th>
                <th style={thNum}>Weight</th>
                <th style={thNum}>Purchase price</th>
                <th style={thNum}>Date</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.id}>
                  <td style={{ ...td, color: C.textStrong, fontWeight: 600 }}>{h.metal}</td>
                  <td style={td}>{h.type}</td>
                  <td style={tdNum}>
                    {h.weight} {h.weightUnit}
                  </td>
                  <td style={tdNum}>${h.purchasePrice.toLocaleString()}</td>
                  <td style={{ ...tdNum, color: C.muted }}>{h.purchaseDate}</td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <Btn variant="ghost" aria-label={`Remove ${h.metal} ${h.type}`} onClick={() => removeHolding(h.id)} style={{ color: C.red }}>
                      ✕
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!showForm ? (
        <div>
          <Btn variant="gold" size="md" onClick={() => setShowForm(true)}>
            + Add holding
          </Btn>
        </div>
      ) : (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {field(
              'Metal',
              <select value={form.metal} onChange={(e) => setForm({ ...form, metal: e.target.value })} style={inputStyle}>
                <option value="gold">Gold</option>
                <option value="silver">Silver</option>
                <option value="platinum">Platinum</option>
                <option value="copper">Copper</option>
              </select>,
            )}
            {field(
              'Type',
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={inputStyle}>
                <option value="bar">Bar</option>
                <option value="coin">Coin</option>
                <option value="round">Round</option>
                <option value="ETF">ETF share</option>
              </select>,
            )}
            {field(`Weight (${form.weightUnit})`, <input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} placeholder="e.g. 1" style={inputStyle} />)}
            {field('Purchase price ($)', <input type="number" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} placeholder="e.g. 2400" style={inputStyle} />)}
            {field('Purchase date', <input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} style={inputStyle} />)}
            {field('Notes', <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" style={inputStyle} />)}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn variant="gold" size="md" onClick={addHolding}>
              Save
            </Btn>
            <Btn variant="outline" size="md" onClick={() => setShowForm(false)}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
