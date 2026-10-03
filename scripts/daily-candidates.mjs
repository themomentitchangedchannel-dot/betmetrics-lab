import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const dayFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Ljubljana', year: 'numeric', month: '2-digit', day: '2-digit'
});
const dayOf = iso => dayFormat.format(new Date(iso));
const markets = ['h2h', 'goals'];
const labels = { h2h: ['1', 'X', '2'], goals: ['Več 2,5', 'Manj 2,5'] };

export function opportunity(record, market, nowIso) {
  const now = Date.parse(nowIso), kickoff = Date.parse(record.kickoffUtc);
  if (record.result !== null || record.scheduleChangedAt ||
      (record.fixtureStatus && !['SCHEDULED', 'TIMED'].includes(record.fixtureStatus)) ||
      !Number.isFinite(now) || !Number.isFinite(kickoff) ||
      kickoff <= now || kickoff > now + 72 * 3600000) return null;
  const quote = market === 'h2h'
    ? (record.latestOddsSnapshot || record.oddsSnapshot)
    : (record.latestTotals25Snapshot || record.totals25Snapshot);
  const predictedAt = market === 'h2h' ? record.predictedAt : record.goalsForecast?.predictedAt;
  const choices = market === 'h2h' ? ['H', 'D', 'A'] : ['Over', 'Under'];
  const i = choices.indexOf(quote?.pick);
  const odds = quote?.odds?.[i], p = market === 'h2h'
    ? record.probs?.[i]
    : i === 0 ? record.goalsForecast?.probs?.over25 : 1 - record.goalsForecast?.probs?.over25;
  const quoted = Date.parse(quote?.quotedAt), predicted = Date.parse(predictedAt);
  if (quote?.bookmaker !== 'betsson' || i < 0 || !Number.isFinite(odds) ||
      odds < 1.4 || odds > 5 || !Number.isFinite(p) || p < 0 || p > 1 ||
      !Number.isFinite(quoted) || !Number.isFinite(predicted) ||
      predicted >= quoted || quoted >= kickoff || quoted > now + 60000 ||
      now - quoted > 24 * 3600000) return null;
  const ev = p * odds - 1;
  if (ev < .05 - 1e-9) return null;
  return {
    id: String(record.id), league: record.league, home: record.home, away: record.away,
    kickoffUtc: record.kickoffUtc, day: dayOf(record.kickoffUtc), market,
    pick: choices[i], label: labels[market][i], odds, probability: p, ev,
    predictedAt, quotedAt: quote.quotedAt, bookmaker: quote.bookmaker,
    bookmakerUpdatedAt: quote.bookmakerUpdatedAt, eventId: quote.eventId
  };
}

function comparableQuote(row, fixture) {
  if (fixture.league !== row.league || fixture.kickoffUtc !== row.kickoffUtc) return null;
  const quote = row.market === 'h2h'
    ? fixture.latestOddsSnapshot : fixture.latestTotals25Snapshot;
  const choices = row.market === 'h2h' ? ['H', 'D', 'A'] : ['Over', 'Under'];
  const index = choices.indexOf(row.pick), quoted = Date.parse(quote?.quotedAt);
  const odds = quote?.odds?.[index], kickoff = Date.parse(row.kickoffUtc);
  if (quote?.bookmaker !== row.bookmaker || (row.eventId && quote.eventId !== row.eventId) ||
      (row.market === 'goals' && quote.point !== 2.5) || index < 0 ||
      !Number.isFinite(quoted) || quoted <= Date.parse(row.selectedAt) || quoted >= kickoff ||
      !Number.isFinite(odds) || odds <= 1.01 || odds >= 100) return null;
  const updated = Date.parse(quote.bookmakerUpdatedAt), originalUpdated = Date.parse(row.bookmakerUpdatedAt);
  if (Number.isFinite(originalUpdated) && (!Number.isFinite(updated) || updated <= originalUpdated)) return null;
  const previous = row.latestComparableQuote;
  if (previous && (quoted <= Date.parse(previous.quotedAt) ||
      (Number.isFinite(Date.parse(previous.bookmakerUpdatedAt)) && updated <= Date.parse(previous.bookmakerUpdatedAt)))) return null;
  return { odds, quotedAt: quote.quotedAt, bookmakerUpdatedAt: quote.bookmakerUpdatedAt };
}

export function evolveDailyCandidates(previous, forecasts, nowIso) {
  if (previous.version !== 1 || !Array.isArray(previous.records) ||
      forecasts.version !== 1 || !Array.isArray(forecasts.records)) throw Error('Invalid candidate or forecast ledger');
  const byId = new Map(forecasts.records.map(record => [String(record.id), record]));
  const records = previous.records.map(row => {
    const fixture = byId.get(String(row.id));
    if (!fixture) return row;
    if (row.voidReason) return row;
    const moved = fixture.league !== row.league ||
      Math.abs(Date.parse(fixture.kickoffUtc) - Date.parse(row.kickoffUtc)) > 30 * 60000 ||
      !!fixture.scheduleChangedAt;
    const voidReason = moved ? 'Spremenjen termin tekme' :
      ['POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(fixture.fixtureStatus) ? 'Preložena ali odpovedana tekma' : null;
    if (voidReason) return { ...row, voidReason, result: null };
    const result = row.market === 'h2h'
      ? (['H', 'D', 'A'].includes(fixture.result) ? fixture.result : null)
      : (Number.isInteger(fixture.resultGoals?.home) && Number.isInteger(fixture.resultGoals?.away)
          ? fixture.resultGoals.home + fixture.resultGoals.away > 2 ? 'Over' : 'Under' : null);
    const latest = comparableQuote(row, fixture);
    return { ...row, result, ...(latest ? { latestComparableQuote: latest } : {}) };
  });
  const selectedIds = new Set(records.map(row => String(row.id)));
  const countByDay = new Map();
  for (const row of records) countByDay.set(row.day, (countByDay.get(row.day) || 0) + 1);
  const candidates = [];
  for (const record of forecasts.records) {
    if (selectedIds.has(String(record.id))) continue;
    const choices = markets.map(market => opportunity(record, market, nowIso)).filter(Boolean);
    choices.sort((a, b) => b.ev - a.ev || a.market.localeCompare(b.market));
    if (choices.length) candidates.push(choices[0]);
  }
  candidates.sort((a, b) => a.day.localeCompare(b.day) || b.ev - a.ev || a.id.localeCompare(b.id));
  let added = 0;
  for (const row of candidates) {
    const count = countByDay.get(row.day) || 0;
    if (count >= 5) continue;
    records.push({ ...row, selectedAt: nowIso, result: null });
    countByDay.set(row.day, count + 1);
    added++;
  }
  return { ledger: { version: 1, generatedAt: nowIso, records }, added };
}

export function dailySummary(ledger) {
  const settled = ledger.records.filter(row => !row.voidReason && row.result !== null);
  const profit = settled.reduce((sum, row) => sum + (row.result === row.pick ? row.odds - 1 : -1), 0);
  return {
    selected: ledger.records.length, voided: ledger.records.filter(row => row.voidReason).length, settled: settled.length,
    wins: settled.filter(row => row.result === row.pick).length,
    profitUnits: profit, roi: settled.length ? profit / settled.length : null
  };
}

function bootstrapInterval(returns, repetitions = 4000) {
  if (returns.length < 30) return null;
  let seed = 0x6d2b79f5;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const means = [];
  for (let trial = 0; trial < repetitions; trial++) {
    let total = 0;
    for (let i = 0; i < returns.length; i++) total += returns[Math.floor(random() * returns.length)];
    means.push(total / returns.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(.025 * repetitions)], means[Math.floor(.975 * repetitions)]];
}

export function auditDailyCandidates(ledger, nowIso) {
  if (ledger?.version !== 1 || !Array.isArray(ledger.records)) throw Error('Invalid daily candidate ledger');
  const valid = ledger.records.filter(row => {
    const selected = Date.parse(row.selectedAt), quoted = Date.parse(row.quotedAt), predicted = Date.parse(row.predictedAt), kickoff = Date.parse(row.kickoffUtc);
    return ['h2h', 'goals'].includes(row.market) && Number.isFinite(selected) && Number.isFinite(quoted) &&
      Number.isFinite(predicted) && Number.isFinite(kickoff) && predicted < quoted && quoted <= selected &&
      selected < kickoff && Number.isFinite(row.odds) && row.odds >= 1.4 && row.odds <= 5 &&
      (row.market === 'h2h' ? ['H', 'D', 'A'] : ['Over', 'Under']).includes(row.pick) &&
      (row.result === null || (row.market === 'h2h' ? ['H', 'D', 'A'] : ['Over', 'Under']).includes(row.result));
  });
  const summarize = rows => {
    const voided = rows.filter(row => row.voidReason);
    const active = rows.filter(row => !row.voidReason);
    const settled = active.filter(row => row.result !== null);
    const returns = settled.map(row => row.result === row.pick ? row.odds - 1 : -1);
    const profitUnits = returns.reduce((sum, value) => sum + value, 0);
    const interval95 = bootstrapInterval(returns);
    const started = active.filter(row => Date.parse(row.kickoffUtc) <= Date.parse(nowIso));
    const compared = started.filter(row => {
      const quote = row.latestComparableQuote;
      return Number.isFinite(quote?.odds) && quote.odds > 1.01 &&
        Date.parse(quote.quotedAt) > Date.parse(row.selectedAt) && Date.parse(quote.quotedAt) < Date.parse(row.kickoffUtc);
    });
    const marketMovement = { started: started.length, compared: compared.length,
      favorable: compared.filter(row => row.latestComparableQuote.odds < row.odds).length,
      average: compared.length ? compared.reduce((sum, row) => sum + row.odds / row.latestComparableQuote.odds - 1, 0) / compared.length : null };
    return { locked: rows.length, voided: voided.length, settled: settled.length, open: active.length - settled.length,
      profitUnits, roi: settled.length ? profitUnits / settled.length : null, interval95,
      marketMovement,
      status: settled.length < 100 ? 'collecting' : interval95[0] > 0 ? 'review' : profitUnits <= 0 ? 'negative' : 'uncertain' };
  };
  return { version: 1, generatedAt: nowIso, minimumSettled: 100,
    overall: summarize(valid), byMarket: { h2h: summarize(valid.filter(row => row.market === 'h2h')),
      goals: summarize(valid.filter(row => row.market === 'goals')) } };
}

async function main() {
  const root = new URL('../', import.meta.url);
  await mkdir(new URL('site/data/', root), { recursive: true });
  const path = new URL('data/daily-candidates.json', root);
  let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    previous = { version: 1, generatedAt: null, records: [] };
  }
  const forecasts = JSON.parse(await readFile(new URL('data/forecast-ledger.json', root), 'utf8'));
  const { ledger, added } = evolveDailyCandidates(previous, forecasts, new Date().toISOString());
  const output = JSON.stringify(ledger, null, 2) + '\n';
  await writeFile(path, output);
  await writeFile(new URL('site/data/daily-candidates.json', root), output);
  const auditOutput = JSON.stringify(auditDailyCandidates(ledger, ledger.generatedAt), null, 2) + '\n';
  await writeFile(new URL('data/selection-audit.json', root), auditOutput);
  await writeFile(new URL('site/data/selection-audit.json', root), auditOutput);
  process.stdout.write('Daily shortlist: ' + added + ' new, ' + dailySummary(ledger).settled + ' settled.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
