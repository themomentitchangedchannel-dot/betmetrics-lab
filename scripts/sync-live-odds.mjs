import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { teamKey } from './backtest-odds.mjs';

const sports = { PL: 'soccer_epl', PD: 'soccer_spain_la_liga', SA: 'soccer_italy_serie_a' };
const leagues = { PL: 'Premier League · API', PD: 'La Liga · API', SA: 'Serie A · API' };
const bookmaker = 'betsson';
const picks = ['H', 'D', 'A'];
const clubAliases = {
  'atletico madrid': 'ath madrid', 'athletic bilbao': 'ath bilbao',
  'celta vigo': 'celta', 'real betis': 'betis',
  'inter milan': 'inter', 'genoa cfc': 'genoa'
};
const clubKey = name => {
  const key = teamKey(String(name || '').replace(/\b(and|y)\b/gi, ' '));
  return clubAliases[key] || key;
};

export function eventFor(record, events) {
  const start = Date.parse(record.kickoffUtc);
  if (!Number.isFinite(start)) return null;
  const matches = events.filter(event =>
    clubKey(event.home_team) === clubKey(record.home) &&
    clubKey(event.away_team) === clubKey(record.away) &&
    Number.isFinite(Date.parse(event.commence_time)) &&
    Math.abs(Date.parse(event.commence_time) - start) <= 2 * 3600000);
  return matches.length === 1 ? matches[0] : null;
}

export function quote(record, event, nowIso) {
  const now = Date.parse(nowIso), kickoff = Date.parse(record.kickoffUtc);
  if (!event || !Number.isFinite(now) || !Number.isFinite(kickoff) || now >= kickoff || Date.parse(record.predictedAt) > now) return null;
  const book = event.bookmakers?.find(b => b.key === bookmaker);
  const market = book?.markets?.find(m => m.key === 'h2h');
  const updatedAt = market?.last_update || book?.last_update;
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated) || updated > now + 60000 || updated >= kickoff || now - updated > 6 * 3600000) return null;
  const odds = [event.home_team, 'Draw', event.away_team].map(name => {
    const outcomes = market?.outcomes?.filter(o => o.name === name && Number.isFinite(Number(o.price)));
    return outcomes?.length === 1 ? Number(outcomes[0].price) : null;
  });
  if (odds.some(o => !Number.isFinite(o) || o <= 1.01 || o >= 100)) return null;
  if (!Array.isArray(record.probs) || record.probs.length !== 3 || record.probs.some(p => !Number.isFinite(p) || p < 0 || p > 1)) return null;
  const ev = odds.map((o, i) => record.probs[i] * o - 1);
  const selection = ev.map((value, i) => ({value, i})).filter(x => x.value >= .05 && odds[x.i] >= 1.4 && odds[x.i] <= 5).sort((a,b) => b.value - a.value)[0];
  return { bookmaker, bookmakerTitle: book.title || 'Betsson', source: 'The Odds API', quotedAt: nowIso, bookmakerUpdatedAt: updatedAt,
    eventId: String(event.id), odds, ev, pick: selection ? picks[selection.i] : null, rule: 'v1: EV >= 5%; odds 1.4–5; highest EV; 1 unit' };
}

export function attachSnapshots(ledger, byLeague, nowIso) {
  let attached = 0;
  const records = ledger.records.map(record => {
    if (record.oddsSnapshot || !Object.values(leagues).includes(record.league) || Date.parse(record.kickoffUtc) <= Date.parse(nowIso)) return record;
    const event = eventFor(record, byLeague[record.league] || []);
    const snapshot = quote(record, event, nowIso);
    if (!snapshot) return record;
    attached++;
    return { ...record, oddsSnapshot: snapshot };
  });
  return { ledger: { ...ledger, records }, attached };
}

export function summarize(ledger) {
  const quoted = ledger.records.filter(r => r.oddsSnapshot);
  const selected = quoted.filter(r => r.oddsSnapshot.pick);
  const settled = selected.filter(r => picks.includes(r.result));
  const profitUnits = settled.reduce((total,r) => total + (r.oddsSnapshot.pick === r.result ? r.oddsSnapshot.odds[picks.indexOf(r.result)] - 1 : -1), 0);
  return { quoted: quoted.length, selected: selected.length, settled: settled.length, profitUnits, roi: settled.length ? profitUnits / settled.length : null };
}

async function main() {
  const root = new URL('../', import.meta.url), file = new URL('data/forecast-ledger.json', root);
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  const key = process.env.THE_ODDS_API_KEY?.trim(), now = new Date().toISOString();
  const status = { version: 1, generatedAt: now, source: 'The Odds API', bookmaker: 'Betsson', configured: !!key, fetched: false, warnings: [] };
  if (key && process.env.FETCH_LIVE_ODDS !== 'false') {
    const byLeague = {};
    for (const [code, sport] of Object.entries(sports)) {
      try {
        const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
        url.search = new URLSearchParams({ apiKey: key, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', bookmakers: bookmaker }).toString();
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const events = await response.json();
        if (!Array.isArray(events)) throw Error('unexpected response');
        byLeague[leagues[code]] = events;
        status.fetched = true;
      } catch (error) { status.warnings.push(`${code}: ${error.message}`); }
    }
    const result = attachSnapshots(ledger, byLeague, now);
    if (result.attached) {
      const output = JSON.stringify(result.ledger, null, 2) + '\n';
      await writeFile(file, output);
      await writeFile(new URL('site/data/forecast-ledger.json', root), output);
    }
    process.stdout.write(`Prospective odds: ${result.attached} new quotes, ${summarize(result.ledger).selected} selected; ${status.warnings.length} feed errors.\n`);
  } else process.stdout.write(key ? 'Odds fetch skipped on code push.\n' : 'Odds feed awaits THE_ODDS_API_KEY.\n');
  await writeFile(new URL('site/data/live-odds-status.json', root), JSON.stringify(status, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
