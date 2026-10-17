import type { Metadata } from 'next';
import MetalsPage from '@/components/Metals/MetalsPage';

export const metadata: Metadata = {
  title: 'Metals and macro — Ruphak Trading Info',
  description: 'Gold, silver, copper and energy futures, the supply, shipping and conflict news that moves them on a map, and a holdings tracker.',
};

// Prices and headlines load in the browser from /api/prices and /api/metals/headlines.
export default function Metals() {
  return <MetalsPage />;
}
