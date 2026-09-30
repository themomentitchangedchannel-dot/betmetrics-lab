import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const picks = ['H', 'D', 'A'];
const brier = (probabilities, outcome) => probabilities.reduce((sum,p,i) => sum + (p - Number(i === outcome)) ** 2, 0);

export function analyzeProspective(ledger, generatedAt) {
  if (ledger?.version !== 1 || !Array.isArray(ledger.records)) throw Error('Invalid forecast ledger');
  const groups = new Map();
  for (const record of ledger.records) {
    if (typeof record.league !== 'string' || !Array.isArray(record.probs) || record.probs.length !== 3 ||
        record.probs.some(p => !Number.isFinite(p) || p < 0 || p > 1) ||
        !Number.isFinite(Date.parse(record.predictedAt)) || !Number.isFinite(Date.parse(record.kickoffUtc)) ||
        Date.parse(record.predictedAt) >= Date.parse(record.kickoffUtc)) continue;
    const group = groups.get(record.league) || { league: record.league, forecasts: 0, quoted: 0, selected: 0, settledQuotes: 0, settledPicks: 0,
      profitUnits: 0, modelScore: 0, marketScore: 0, marginSum: 0 };
    group.forecasts++;
    const q = record.oddsSnapshot;
    if (q?.bookmaker === 'betsson' && Array.isArray(q.odds) && q.odds.length === 3 &&
        q.odds.every(o => Number.isFinite(o) && o > 1.01 && o < 100) &&
        Number.isFinite(Date.parse(q.quotedAt)) && Date.parse(record.predictedAt) < Date.parse(q.quotedAt) &&
        Date.parse(q.quotedAt) < Date.parse(record.kickoffUtc) &&
        Number.isFinite(Date.parse(q.bookmakerUpdatedAt)) && Date.parse(q.bookmakerUpdatedAt) < Date.parse(record.kickoffUtc)) {
      group.quoted++;
      const sum = q.odds.reduce((acc,o) => acc + 1/o, 0);
      group.marginSum += sum - 1;
      const selected = picks.includes(q.pick);
      if (selected) group.selected++;
      if (picks.includes(record.result)) {
        group.settledQuotes++;
        const outcome = picks.indexOf(record.result), fair = q.odds.map(o => (1/o)/sum);
        group.modelScore += brier(record.probs,outcome);
        group.marketScore += brier(fair,outcome);
        if (selected) {
          group.settledPicks++;
          group.profitUnits += q.pick === record.result ? q.odds[outcome] - 1 : -1;
        }
      }
    }
    groups.set(record.league,group);
  }
  const rows = [...groups.values()].sort((a,b) => a.league.localeCompare(b.league));
  const total = key => rows.reduce((sum,row) => sum + row[key],0);
  const summarize = row => ({ league: row.league, forecasts: row.forecasts, quoted: row.quoted, selected: row.selected,
    settledQuotes: row.settledQuotes, settledPicks: row.settledPicks, profitUnits: row.profitUnits,
    roi: row.settledPicks ? row.profitUnits / row.settledPicks : null,
    brierModel: row.settledQuotes ? row.modelScore / row.settledQuotes : null,
    brierMarket: row.settledQuotes ? row.marketScore / row.settledQuotes : null,
    avgOverround: row.quoted ? row.marginSum / row.quoted : null });
  const overall = Object.fromEntries(['forecasts','quoted','selected','settledQuotes','settledPicks','profitUnits','modelScore','marketScore','marginSum'].map(key => [key,total(key)]));
  return { version: 1, generatedAt, bookmaker: 'Betsson', rule: 'Poisson v1; EV >= 5%; odds 1.4–5; highest EV; 1 unit',
    overall: summarize({ league: 'Vse lige', ...overall }), byLeague: rows.map(summarize) };
}

async function main() {
  const root = new URL('../',import.meta.url);
  const ledger = JSON.parse(await readFile(new URL('data/forecast-ledger.json',root),'utf8'));
  const report = analyzeProspective(ledger,new Date().toISOString());
  await writeFile(new URL('site/data/prospective-report.json',root),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(`Prospective audit: ${report.overall.quoted}/${report.overall.forecasts} quotes, ${report.overall.selected} selections, ${report.overall.settledQuotes} results.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
