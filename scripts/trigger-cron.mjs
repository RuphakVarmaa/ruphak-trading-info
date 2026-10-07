// Fires a cron trigger on a locally running engine Worker (`npm run dev:engine`).
// Usage: npm run cron:local -- "* 3-10 * * MON-FRI"   (defaults to the minute engine wake-up)
const cron = process.argv[2] ?? "* 3-10 * * MON-FRI";
const port = process.env.ENGINE_PORT ?? "8787";
const url = `http://localhost:${port}/__scheduled?cron=${encodeURIComponent(cron)}`;
const res = await fetch(url);
console.log(res.status, await res.text());
