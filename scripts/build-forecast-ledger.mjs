import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const codes = { PL: 'Premier League · API', PD: 'La Liga · API', SA: 'Serie A · API' };
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Ljubljana', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateOf = utc => day.format(new Date(utc));
const poisson = lambda => { const p = [Math.exp(-lambda)]; for (let i = 1; i <= 12; i++) p.push(p[i - 1] * lambda / i); return p; };

export function predict(games, league, home, away, date) {
  const hist = games.filter(g => g.league === league && g.date < date);
  const hh = hist.filter(g => g.home === home), ha = hist.filter(g => g.away === home);
  const ah = hist.filter(g => g.home === away), aa = hist.filter(g => g.away === away);
  if (hist.length < 30 || hh.length + ha.length < 8 || ah.length + aa.length < 8 || hh.length < 3 || aa.length < 3) return null;
  const homeAvg = hist.reduce((s, g) => s + g.hg, 0) / hist.length;
  const awayAvg = hist.reduce((s, g) => s + g.ag, 0) / hist.length;
  if (homeAvg < .2 || awayAvg < .2) return null;
  const avg = (arr, key, prior) => (arr.reduce((s, g) => s + g[key], 0) + 8 * prior) / (arr.length + 8);
  const lh = Math.max(.15, Math.min(5, homeAvg * (avg(hh, 'hg', homeAvg) / homeAvg) * (avg(aa, 'hg', homeAvg) / homeAvg)));
  const la = Math.max(.15, Math.min(5, awayAvg * (avg(aa, 'ag', awayAvg) / awayAvg) * (avg(hh, 'ag', awayAvg) / awayAvg)));
  const ph = poisson(lh), pa = poisson(la), probs = [0, 0, 0];
  for (let i = 0; i < ph.length; i++) for (let j = 0; j < pa.length; j++) probs[i > j ? 0 : i === j ? 1 : 2] += ph[i] * pa[j];
  const total = probs.reduce((x, y) => x + y, 0);
  const counts = [0, 0, 0];
  for (const g of hist) counts[g.hg > g.ag ? 0 : g.hg === g.ag ? 1 : 2]++;
  return { probs: probs.map(p => p / total), baseline: counts.map(n => n / hist.length), n: hist.length };
}

export function evolveLedger(previous, payloads, nowIso) {
  if (previous.version !== 1 || !Array.isArray(previous.records)) throw new Error('Invalid forecast ledger');
  const now = Date.parse(nowIso), limit = now + 14 * 86400000;
  const records = previous.records.map(r => ({ ...r })), byId = new Map(records.map(r => [String(r.id), r]));
  let added = 0, settled = 0, skipped = 0;
  for (const [code, matches] of Object.entries(payloads)) {
    const league = codes[code];
    if (!league || !Array.isArray(matches)) throw new Error(`Invalid matches: ${code}`);
    const finished = matches.filter(m => m.status === 'FINISHED' && Number.isInteger(m.score?.fullTime?.home) && Number.isInteger(m.score?.fullTime?.away));
    const games = finished.filter(m => m.homeTeam?.name && m.awayTeam?.name && Number.isFinite(Date.parse(m.utcDate))).map(m => ({ league, date: dateOf(m.utcDate), home: m.homeTeam.name, away: m.awayTeam.name, hg: m.score.fullTime.home, ag: m.score.fullTime.away }));
    for (const m of finished) {
      const record = byId.get(String(m.id));
      if (!record) continue;
      const result = m.score.fullTime.home > m.score.fullTime.away ? 'H' : m.score.fullTime.home === m.score.fullTime.away ? 'D' : 'A';
      if (record.result !== result) { record.result = result; settled++; }
    }
    for (const m of matches) {
      const kickoff = Date.parse(m.utcDate);
      if (!['SCHEDULED', 'TIMED'].includes(m.status) || !Number.isFinite(kickoff) || kickoff <= now || kickoff > limit) continue;
      if (byId.has(String(m.id))) continue;
      const home = m.homeTeam?.name, away = m.awayTeam?.name;
      if (!m.id || !home || !away || home === away) { skipped++; continue; }
      const forecast = predict(games, league, home, away, dateOf(m.utcDate));
      if (!forecast) { skipped++; continue; }
      const record = { id: m.id, league, kickoffUtc: m.utcDate, home, away, predictedAt: nowIso, probs: forecast.probs, baseline: forecast.baseline, trainingMatches: forecast.n, result: null };
      records.push(record); byId.set(String(m.id), record); added++;
    }
  }
  return { ledger: { version: 1, generatedAt: nowIso, records }, added, settled, skipped };
}

async function main() {
  const root = new URL('../', import.meta.url), ledgerPath = new URL('data/forecast-ledger.json', root);
  const previous = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const payloads = {};
  for (const code of Object.keys(codes)) {
    const payload = JSON.parse(await readFile(new URL(`site/data/${code}.json`, root), 'utf8'));
    payloads[code] = payload.matches;
  }
  const { ledger, added, settled, skipped } = evolveLedger(previous, payloads, new Date().toISOString());
  const output = JSON.stringify(ledger, null, 2) + '\n';
  await mkdir(new URL('site/data/', root), { recursive: true });
  await writeFile(ledgerPath, output);
  await writeFile(new URL('site/data/forecast-ledger.json', root), output);
  process.stdout.write(`Forecast ledger: ${added} new, ${settled} settled, ${skipped} without sufficient history; ${ledger.records.length} total\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
