import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { predict } from './build-forecast-ledger.mjs';

const leagues = { PL: ['E0', 'Premier League · API'], PD: ['SP1', 'La Liga · API'], SA: ['I1', 'Serie A · API'] };
const localDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Ljubljana', year: 'numeric', month: '2-digit', day: '2-digit' });
const aliases = {
  'manchester united': 'man united', 'manchester city': 'man city', 'tottenham hotspur': 'tottenham', 'nottingham forest': 'nottm forest', 'wolverhampton wanderers': 'wolves',
  'brighton hove albion': 'brighton', 'newcastle united': 'newcastle', 'west ham united': 'west ham', 'leeds united': 'leeds', 'sheffield united': 'sheffield united',
  'club atletico de madrid': 'ath madrid', 'atletico de madrid': 'ath madrid', 'athletic club': 'ath bilbao', 'real betis balompie': 'betis', 'real sociedad de futbol': 'sociedad',
  'rc celta de vigo': 'celta', 'rayo vallecano de madrid': 'rayo vallecano', 'rcd espanyol de barcelona': 'espanol', 'rcd mallorca': 'mallorca',
  'deportivo alaves': 'alaves', 'real valladolid': 'valladolid', 'ca osasuna': 'osasuna', 'real oviedo': 'oviedo', 'real madrid': 'real madrid',
  'fc barcelona': 'barcelona', 'rc deportivo la coruna': 'deportivo', 'real racing club de santander': 'racing santander',
  'internazionale milano': 'inter', 'milan': 'milan', 'as roma': 'roma', 'ssc napoli': 'napoli', 'lazio': 'lazio',
  'acf fiorentina': 'fiorentina', 'parma': 'parma', 'bologna': 'bologna', 'lecce': 'lecce',
  'us sassuolo calcio': 'sassuolo', 'cagliari calcio': 'cagliari', 'genoa': 'genoa', 'udinese calcio': 'udinese',
  'juventus': 'juventus', 'atalanta': 'atalanta', 'torino': 'torino', 'frosinone calcio': 'frosinone',
};

export function teamKey(name) {
  let key = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  key = key.replace(/^(fc|afc|ac|cf|ud|us|ss) /, '').replace(/ (fc|afc|cf|calcio|1909|1913)\b/g, '').trim();
  return aliases[key] || key;
}

export function csvRows(text) {
  const rows = []; let row = [], field = '', quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quote && text[i+1] === '"') { field += '"'; i++; } else quote = !quote; }
    else if (c === ',' && !quote) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quote) { if (c === '\r' && text[i+1] === '\n') i++; row.push(field); if (row.some(x => x.trim())) rows.push(row); row = []; field = ''; }
    else field += c;
  }
  row.push(field); if (row.some(x => x.trim())) rows.push(row);
  const headers = rows.shift()?.map(x => x.replace(/^\uFEFF/, '').trim()) || [];
  return rows.map(values => Object.fromEntries(headers.map((key,i) => [key, values[i]?.trim() || ''])));
}

function oddsDate(text) {
  const bits = String(text).split('/');
  if (bits.length !== 3) return null;
  let [d,m,y] = bits.map(Number); if (!d || !m || !y) return null;
  if (y < 100) y += 2000;
  const iso = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function evaluateOdds(apiMatches, csvText, league, season) {
  const games = apiMatches.filter(m => m.status === 'FINISHED' && Number.isInteger(m.score?.fullTime?.home) && Number.isInteger(m.score?.fullTime?.away))
    .map(m => ({ date: localDay.format(new Date(m.utcDate)), league, home: m.homeTeam.name, away: m.awayTeam.name, hg: m.score.fullTime.home, ag: m.score.fullTime.away }));
  const csv = csvRows(csvText).filter(r => r.HomeTeam && r.AwayTeam && oddsDate(r.Date) && ['H','D','A'].includes(r.FTR));
  const byMatch = new Map();
  for (const r of csv) {
    const key = `${oddsDate(r.Date)}:${teamKey(r.HomeTeam)}:${teamKey(r.AwayTeam)}`;
    byMatch.set(key,[...(byMatch.get(key)||[]),r]);
  }
  const output = [], unmatched = [], counts = { completed: 0, matched: 0, missingOdds: 0, resultMismatch: 0, noPrediction: 0 };
  for (const g of games) {
    const gameSeason = Number(g.date.slice(0,4)) - Number(Number(g.date.slice(5,7)) < 7);
    if (gameSeason !== season) continue;
    counts.completed++;
    const candidates = byMatch.get(`${g.date}:${teamKey(g.home)}:${teamKey(g.away)}`);
    if (candidates?.length !== 1) {
      if (unmatched.length < 12) unmatched.push(`${g.date} ${g.home} / ${g.away} → ${(csv.filter(r=>oddsDate(r.Date)===g.date).map(r=>`${r.HomeTeam} / ${r.AwayTeam}`).slice(0,8)).join(' | ')}`);
      continue;
    }
    const r = candidates[0];
    const actual = g.hg > g.ag ? 'H' : g.hg === g.ag ? 'D' : 'A';
    if (r.FTR !== actual) { counts.resultMismatch++; continue; }
    counts.matched++;
    const odds = ['B365CH','B365CD','B365CA'].map(key => Number(r[key]));
    if (!odds.every(x => Number.isFinite(x) && x > 1.01 && x < 100)) { counts.missingOdds++; continue; }
    const model = predict(games, league, g.home, g.away, g.date);
    if (!model) { counts.noPrediction++; continue; }
    const n = ['H','D','A'].indexOf(actual), overround = odds.reduce((sum,x)=>sum+1/x,0);
    const fair = odds.map(x => (1/x)/overround);
    const ev = model.probs.map((p,i) => p*odds[i]-1);
    // Fixed rule, chosen before inspecting the test season: at most one pick per match.
    const selections = ev.map((value,i)=>({value,i})).filter(x=>x.value >= .05 && odds[x.i] >= 1.4 && odds[x.i] <= 5);
    selections.sort((a,b)=>b.value-a.value);
    const chosen = selections[0];
    const score = probs=>probs.reduce((sum,p,i)=>sum+(p-Number(i===n))**2,0);
    output.push({ date:g.date, home:g.home, away:g.away, actual, probs:model.probs, odds, overround, brierModel:score(model.probs), brierMarket:score(fair),
      pick:chosen ? ['H','D','A'][chosen.i] : null, quotedEv:chosen?.value ?? null, profit:chosen ? (chosen.i===n ? odds[n]-1 : -1) : null });
  }
  return { rows: output, unmatched, counts: { ...counts, eligible: output.length, selected: output.filter(r=>r.pick).length } };
}

export function summarizeOdds(parts, generatedAt) {
  const seasons = [];
  for (const [season, group] of [...new Set(parts.map(p=>p.season))].sort().map(season=>[season,parts.filter(p=>p.season===season)])) {
    const rows = group.flatMap(p=>p.rows), bets = rows.filter(r=>r.pick);
    const n = rows.length, wagered = bets.length, profit = bets.reduce((s,r)=>s+r.profit,0);
    seasons.push({ season, n, matched:group.reduce((s,p)=>s+p.counts.matched,0), completed:group.reduce((s,p)=>s+p.counts.completed,0),
      brierModel:n ? rows.reduce((s,r)=>s+r.brierModel,0)/n : null, brierMarket:n ? rows.reduce((s,r)=>s+r.brierMarket,0)/n : null,
      selected:wagered, profitUnits:profit, roi:wagered ? profit/wagered : null,
      byLeague:group.map(p=>({league:p.league, ...p.counts, profitUnits:p.rows.filter(r=>r.pick).reduce((s,r)=>s+r.profit,0)})) });
  }
  return { version:1, generatedAt, source:'football-data.co.uk', book:'Bet365', oddsType:'closing', strategy:'Poisson v1; highest EV >= 5%; decimal odds 1.4 to 5; one 1/X/2 selection per match; 1 unit flat stake', seasons };
}

async function main() {
  const root = new URL('../', import.meta.url), parts = [], warnings = [];
  for (const [code,[division,league]] of Object.entries(leagues)) {
    const data = JSON.parse(await readFile(new URL(`site/data/${code}.json`,root),'utf8'));
    for (const season of [2025,2026]) {
      const path = `${String(season).slice(2)}${String(season+1).slice(2)}`;
      const url = `https://www.football-data.co.uk/mmz4281/${path}/${division}.csv`;
      try {
        const response = await fetch(url, { signal:AbortSignal.timeout(15000) });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const csv = await response.text();
        const result = evaluateOdds(data.matches,csv,league,season);
        parts.push({ season, league, ...result });
        process.stdout.write(`${division} ${path}: matched ${result.counts.matched}/${result.counts.completed}, eligible ${result.counts.eligible}, selected ${result.counts.selected}\n`);
        process.stdout.write(result.unmatched.map(x=>`  unmatched: ${x}`).join('\n')+'\n');
      } catch (error) {
        warnings.push(`${division} ${path}: ${error.message}`);
        process.stdout.write(`Odds unavailable: ${warnings.at(-1)}\n`);
      }
    }
  }
  const report = { ...summarizeOdds(parts,new Date().toISOString()), warnings };
  await mkdir(new URL('site/data/',root),{recursive:true});
  await writeFile(new URL('site/data/profit-backtest.json',root),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(`Closing-odds backtest: ${report.seasons.map(s=>`${s.season}: ${s.selected} picks, ${s.profitUnits.toFixed(2)} units`).join('; ')}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
