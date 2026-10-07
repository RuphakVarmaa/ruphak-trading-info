'use client';

import { useState, useSyncExternalStore } from 'react';
import type { CommodityPrice, StackHolding } from '@/utils/api';
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
  prices: CommodityPrice[];
}

export default function StackTracker({ prices }: StackTrackerProps) {
  const holdings = useSyncExternalStore(subscribeHoldings, loadHoldings, serverHoldings);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ metal: 'gold', type: 'bar', weight: '', weightUnit: 'oz' as const, purchasePrice: '', purchaseDate: '', notes: '' });

  const summary = calculateStackSummary(holdings, prices);

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

  return (
    <div style={{ padding: '24px 30px', background: '#0a0a0a' }}>
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#ffb300', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          PERSONAL TRACKER
        </span>
      </div>
      <h3 style={{ margin: '0 0 6px', fontSize: 26, fontWeight: 400, color: '#e0e0e0', fontFamily: 'Georgia, serif' }}>
        Your Precious Metals Stack
      </h3>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#666' }}>
        Track your physical metals holdings with real-time valuations. Data stored locally in your browser.
      </p>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Total Value</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#ffb300', fontFamily: 'monospace' }}>
            ${summary.totalValueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Cost Basis</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#ccc', fontFamily: 'monospace' }}>
            ${summary.totalCostBasis.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Gain/Loss</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: summary.totalGainLoss >= 0 ? '#4caf50' : '#f44336', fontFamily: 'monospace' }}>
            {summary.totalGainLoss >= 0 ? '+' : ''}${summary.totalGainLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 9, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Return %</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: summary.totalGainLossPercent >= 0 ? '#4caf50' : '#f44336', fontFamily: 'monospace' }}>
            {summary.totalGainLossPercent >= 0 ? '+' : ''}{summary.totalGainLossPercent.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Per-Metal Breakdown */}
      {summary.holdings.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 20 }}>
          {summary.holdings.map(h => (
            <div key={h.metal} style={{ background: '#151515', border: '1px solid #222', borderRadius: 6, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#ffb300', marginBottom: 6 }}>{h.metal}</div>
              <div style={{ fontSize: 11, color: '#aaa', marginBottom: 2 }}>{h.totalOz.toFixed(2)} oz</div>
              <div style={{ fontSize: 11, color: '#eee', fontFamily: 'monospace' }}>${h.totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
              <div style={{ fontSize: 10, color: h.gainLoss >= 0 ? '#4caf50' : '#f44336', fontFamily: 'monospace' }}>
                {h.gainLoss >= 0 ? '+' : ''}{h.gainLossPercent.toFixed(2)}%
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Holdings Table */}
      {holdings.length > 0 && (
        <div style={{ border: '1px solid #222', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#151515', color: '#888', textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.06em' }}>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Metal</th>
                <th style={{ padding: '10px 12px', textAlign: 'left' }}>Type</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Weight</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Purchase Price</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Date</th>
                <th style={{ padding: '10px 12px', textAlign: 'center' }}></th>
              </tr>
            </thead>
            <tbody>
              {holdings.map(h => (
                <tr key={h.id} style={{ borderTop: '1px solid #1a1a1a' }}>
                  <td style={{ padding: '8px 12px', color: '#ffb300', fontWeight: 600 }}>{h.metal}</td>
                  <td style={{ padding: '8px 12px', color: '#aaa' }}>{h.type}</td>
                  <td style={{ padding: '8px 12px', color: '#eee', textAlign: 'right', fontFamily: 'monospace' }}>{h.weight} {h.weightUnit}</td>
                  <td style={{ padding: '8px 12px', color: '#eee', textAlign: 'right', fontFamily: 'monospace' }}>${h.purchasePrice.toLocaleString()}</td>
                  <td style={{ padding: '8px 12px', color: '#888', textAlign: 'right' }}>{h.purchaseDate}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                    <button onClick={() => removeHolding(h.id)} style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer', fontSize: 14 }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Button / Form */}
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{ background: '#ffb300', color: '#000', border: 'none', padding: '10px 24px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          + Add Holding
        </button>
      ) : (
        <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 9, color: '#888', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Metal</label>
              <select value={form.metal} onChange={e => setForm({ ...form, metal: e.target.value })} style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 4, color: '#eee', padding: '8px', fontSize: 12 }}>
                <option value="gold">Gold</option>
                <option value="silver">Silver</option>
                <option value="platinum">Platinum</option>
                <option value="copper">Copper</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 9, color: '#888', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 4, color: '#eee', padding: '8px', fontSize: 12 }}>
                <option value="bar">Bar</option>
                <option value="coin">Coin</option>
                <option value="round">Round</option>
                <option value="ETF">ETF Share</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 9, color: '#888', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Weight ({form.weightUnit})</label>
              <input type="number" value={form.weight} onChange={e => setForm({ ...form, weight: e.target.value })} placeholder="e.g. 1" style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 4, color: '#eee', padding: '8px', fontSize: 12, boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={{ fontSize: 9, color: '#888', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Purchase Price ($)</label>
              <input type="number" value={form.purchasePrice} onChange={e => setForm({ ...form, purchasePrice: e.target.value })} placeholder="e.g. 2400" style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 4, color: '#eee', padding: '8px', fontSize: 12, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 9, color: '#888', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Purchase Date</label>
              <input type="date" value={form.purchaseDate} onChange={e => setForm({ ...form, purchaseDate: e.target.value })} style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 4, color: '#eee', padding: '8px', fontSize: 12, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 9, color: '#888', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Notes</label>
              <input type="text" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Optional" style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 4, color: '#eee', padding: '8px', fontSize: 12, boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={addHolding} style={{ background: '#ffb300', color: '#000', border: 'none', padding: '8px 20px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Save</button>
            <button onClick={() => setShowForm(false)} style={{ background: 'transparent', color: '#888', border: '1px solid #333', padding: '8px 20px', borderRadius: 5, fontSize: 11, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
