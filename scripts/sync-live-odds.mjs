import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { teamKey } from './backtest-odds.mjs';

const sports = { PL: 'soccer_epl', PD: 'soccer_spain_la_liga', SA: 'soccer_italy_serie_a', BL1: 'soccer_germany_bundesliga' };
const leagues = { PL: 'Premier League · API', PD: 'La Liga · API', SA: 'Serie A · API', BL1: 'Bundesliga · API' };
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
  if (!event || record.scheduleChangedAt || !Number.isFinite(now) || !Number.isFinite(kickoff) || now >= kickoff || Date.parse(record.predictedAt) > now) return null;
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

export function quoteTotals25(record, event, nowIso) {
  const forecast=record.goalsForecast,now=Date.parse(nowIso),kickoff=Date.parse(record.kickoffUtc);
  if (!event || !forecast || record.scheduleChangedAt || !Number.isFinite(now) || now >= kickoff || Date.parse(forecast.predictedAt) > now) return null;
  const book=event.bookmakers?.find(b=>b.key===bookmaker),market=book?.markets?.find(m=>m.key==='totals');
  const updatedAt=market?.last_update || book?.last_update,updated=Date.parse(updatedAt);
  if(!Number.isFinite(updated)||updated>now+60000||updated>=kickoff||now-updated>6*3600000)return null;
  const odds=['Over','Under'].map(name=>{
    const matches=market?.outcomes?.filter(o=>o.name===name&&Number(o.point)===2.5);
    return matches?.length===1?Number(matches[0].price):null;
  });
  if(odds.some(o=>!Number.isFinite(o)||o<=1.01||o>=100))return null;
  const p=forecast.probs?.over25;
  if(!Number.isFinite(p)||p<0||p>1)return null;
  const ev=[p*odds[0]-1,(1-p)*odds[1]-1];
  const selection=ev.map((value,i)=>({value,i})).filter(x=>x.value>=.05&&odds[x.i]>=1.4&&odds[x.i]<=5).sort((a,b)=>b.value-a.value)[0];
  return {bookmaker,source:'The Odds API',quotedAt:nowIso,bookmakerUpdatedAt:updatedAt,eventId:String(event.id),point:2.5,
    odds,ev,pick:selection?['Over','Under'][selection.i]:null,rule:'goals-v1: EV >= 5%; odds 1.4–5; highest EV; 1 unit'};
}

export function attachSnapshots(ledger, byLeague, nowIso) {
  let attached = 0, totalsAttached=0;
  const records = ledger.records.map(record => {
    if (!Object.values(leagues).includes(record.league) || Date.parse(record.kickoffUtc) <= Date.parse(nowIso) || (record.oddsSnapshot && record.totals25Snapshot)) return record;
    const event = eventFor(record, byLeague[record.league] || []);
    const snapshot = record.oddsSnapshot ? null : quote(record, event, nowIso);
    const totals25 = record.totals25Snapshot ? null : quoteTotals25(record,event,nowIso);
    if (!snapshot && !totals25) return record;
    if(snapshot)attached++;
    if(totals25)totalsAttached++;
    return { ...record, ...(snapshot?{oddsSnapshot:snapshot}:{}), ...(totals25?{totals25Snapshot:totals25}:{}) };
  });
  return { ledger: { ...ledger, records }, attached, totalsAttached };
}

export function updateLatestQuotes(ledger, byLeague, nowIso) {
  let updated = 0;
  const records = ledger.records.map(record => {
    if (!Object.values(leagues).includes(record.league) || Date.parse(record.kickoffUtc) <= Date.parse(nowIso)) return record;
    const event = eventFor(record, byLeague[record.league] || []);
    const h2h = quote(record, event, nowIso);
    const totals = quoteTotals25(record, event, nowIso);
    if (!h2h && !totals) return record;
    const changes = {};
    if (h2h && Date.parse(h2h.quotedAt) > Date.parse(record.latestOddsSnapshot?.quotedAt || 0)) changes.latestOddsSnapshot = h2h;
    if (totals && Date.parse(totals.quotedAt) > Date.parse(record.latestTotals25Snapshot?.quotedAt || 0)) changes.latestTotals25Snapshot = totals;
    if (!Object.keys(changes).length) return record;
    updated++;
    return {...record, ...changes};
  });
  return {ledger:{...ledger,records},updated};
}

export function summarize(ledger) {
  const quoted = ledger.records.filter(r => r.oddsSnapshot);
  const selected = quoted.filter(r => r.oddsSnapshot.pick);
  const settled = selected.filter(r => picks.includes(r.result));
  const profitUnits = settled.reduce((total,r) => total + (r.oddsSnapshot.pick === r.result ? r.oddsSnapshot.odds[picks.indexOf(r.result)] - 1 : -1), 0);
  return { quoted: quoted.length, selected: selected.length, settled: settled.length, profitUnits, roi: settled.length ? profitUnits / settled.length : null };
}

export function diagnoseCoverage(ledger, byLeague, nowIso) {
  const byLeagueCounts = {};
  const total = { forecasts: 0, matched: 0, h2h: 0, totals: 0, line25: 0, valid25: 0 };
  for (const [league, events] of Object.entries(byLeague)) {
    const counts = { forecasts: 0, matched: 0, h2h: 0, totals: 0, line25: 0, valid25: 0 };
    for (const record of ledger.records) {
      if (record.league !== league || !record.goalsForecast ||
          Date.parse(record.kickoffUtc) <= Date.parse(nowIso)) continue;
      counts.forecasts++;
      const event = eventFor(record, events);
      if (!event) continue;
      counts.matched++;
      const book = event.bookmakers?.find(b => b.key === bookmaker);
      if (book?.markets?.some(m => m.key === 'h2h')) counts.h2h++;
      const market = book?.markets?.find(m => m.key === 'totals');
      if (!market) continue;
      counts.totals++;
      if (market.outcomes?.some(o => Number(o.point) === 2.5)) counts.line25++;
      if (quoteTotals25(record, event, nowIso)) counts.valid25++;
    }
    byLeagueCounts[league] = counts;
    for (const key of Object.keys(total)) total[key] += counts[key];
  }
  return { total, byLeague: byLeagueCounts };
}

async function main() {
  const root = new URL('../', import.meta.url), file = new URL('data/forecast-ledger.json', root);
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  const key = process.env.THE_ODDS_API_KEY?.trim(), now = new Date().toISOString();
  let status = { version: 2, generatedAt: now, source: 'The Odds API', bookmaker: 'Betsson', configured: !!key, fetched: false, warnings: [], coverage: null, quotaRemaining: null, quotaUsed: null, skippedLeagues: [] };
  if (key && process.env.FETCH_LIVE_ODDS !== 'false') {
    const byLeague = {};
    for (const [code, sport] of Object.entries(sports)) {
      if (code === 'BL1' && process.env.FETCH_BL1_ODDS === 'false') {
        status.skippedLeagues.push(code);
        continue;
      }
      if (status.quotaRemaining !== null && status.quotaRemaining < 22) {
        status.warnings.push('Quota below 22 credits; remaining league requests deferred.');
        status.skippedLeagues.push(code);
        continue;
      }
      try {
        const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
        url.search = new URLSearchParams({ apiKey: key, regions: 'eu', markets: 'h2h,totals', oddsFormat: 'decimal', bookmakers: bookmaker }).toString();
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const remaining = Number(response.headers.get('x-requests-remaining'));
        const used = Number(response.headers.get('x-requests-used'));
        if (response.headers.has('x-requests-remaining') && Number.isFinite(remaining)) status.quotaRemaining = remaining;
        if (response.headers.has('x-requests-used') && Number.isFinite(used)) status.quotaUsed = used;
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const events = await response.json();
        if (!Array.isArray(events)) throw Error('unexpected response');
        byLeague[leagues[code]] = events;
        status.fetched = true;
      } catch (error) { status.warnings.push(`${code}: ${error.message}`); }
    }
    status.coverage = diagnoseCoverage(ledger, byLeague, now);
    const result = attachSnapshots(ledger, byLeague, now);
    const latest = updateLatestQuotes(result.ledger, byLeague, now);
    if (result.attached || result.totalsAttached || latest.updated) {
      const output = JSON.stringify(latest.ledger, null, 2) + '\n';
      await writeFile(file, output);
      await writeFile(new URL('site/data/forecast-ledger.json', root), output);
    }
    process.stdout.write(`Prospective odds: ${result.attached} h2h quotes, ${result.totalsAttached} over/under 2.5 quotes, ${summarize(latest.ledger).selected} h2h selections, ${latest.updated} latest quotes updated; ${status.warnings.length} feed errors.\n`);
  } else {
    try {
      const previous = JSON.parse(await readFile(new URL('data/live-odds-status.json', root), 'utf8'));
      if (previous?.version === 2) status = previous;
    } catch { /* The first run has no persisted feed status. */ }
    process.stdout.write(key ? 'Odds fetch skipped on code push.\n' : 'Odds feed awaits THE_ODDS_API_KEY.\n');
  }
  await writeFile(new URL('data/live-odds-status.json', root), JSON.stringify(status, null, 2) + '\n');
  await writeFile(new URL('site/data/live-odds-status.json', root), JSON.stringify(status, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
