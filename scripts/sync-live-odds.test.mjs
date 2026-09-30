import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { eventFor, quote, quoteTotals25, attachSnapshots, updateLatestQuotes, summarize, diagnoseCoverage } from './sync-live-odds.mjs';

const now = '2026-10-01T10:00:00Z';
const record = { id: 1, league: 'Premier League · API', kickoffUtc: '2026-10-02T14:00:00Z', home: 'Arsenal FC', away: 'Brighton & Hove Albion FC', predictedAt: '2026-09-30T09:00:00Z', probs: [.55,.25,.20], result: null };
const event = { id:'odds-1', commence_time: record.kickoffUtc, home_team:'Arsenal', away_team:'Brighton and Hove Albion', bookmakers:[{key:'betsson',title:'Betsson',markets:[{key:'h2h',last_update:'2026-10-01T09:55:00Z',outcomes:[{name:'Arsenal',price:1.8},{name:'Draw',price:4.6},{name:'Brighton and Hove Albion',price:5.1}]}]}] };

test('match exactly one fixture with club aliases and kickoff tolerance', () => {
  assert.equal(eventFor(record,[event]),event);
  assert.equal(eventFor(record,[event,event]),null);
  assert.equal(eventFor(record,[{...event,commence_time:'2026-10-03T14:00:00Z'}]),null);
  const pairs=[
    ['Club Atlético de Madrid','Atletico Madrid'],['Athletic Club','Athletic Bilbao'],
    ['RC Celta de Vigo','Celta Vigo'],['Real Betis Balompié','Real Betis'],
    ['FC Internazionale Milano','Inter Milan'],['Genoa CFC','Genoa']
  ];
  for(const [api,odds] of pairs){
    const fixture={...record,home:api,away:'Arsenal FC'};
    const candidate={...event,home_team:odds,away_team:'Arsenal'};
    assert.equal(eventFor(fixture,[candidate]),candidate,api);
  }
});

test('fixed rule locks one quote and settles a flat stake', () => {
  const chosen = quote(record,event,now);
  assert.deepEqual(chosen.odds,[1.8,4.6,5.1]);
  assert.equal(chosen.pick,'D'); // EV 15%, whereas home outcome has negative EV.
  const start = {version:1,records:[record]};
  const first = attachSnapshots(start,{[record.league]:[event]},now);
  assert.equal(first.attached,1);
  assert.equal(summarize(first.ledger).selected,1);
  const changed = structuredClone(event);changed.bookmakers[0].markets[0].outcomes[1].price=100;
  const second = attachSnapshots(first.ledger,{[record.league]:[changed]},'2026-10-01T12:00:00Z');
  assert.equal(second.attached,0);
  assert.deepEqual(second.ledger.records[0].oddsSnapshot,chosen);
  const win = summarize({records:[{...second.ledger.records[0],result:'D'}]});
  assert.ok(Math.abs(win.profitUnits-3.6)<1e-9);assert.ok(Math.abs(win.roi-3.6)<1e-9);
  const loss = summarize({records:[{...second.ledger.records[0],result:'H'}]});
  assert.equal(loss.profitUnits,-1);
});

test('no retroactive, ambiguous, stale or incomplete bookmaker quotes', () => {
  assert.equal(quote(record,event,'2026-10-02T14:00:00Z'),null);
  assert.equal(quote({...record,predictedAt:'2026-10-02T15:00:00Z'},event,now),null);
  assert.equal(quote(record,{...event,bookmakers:[]},now),null);
  const stale=structuredClone(event);stale.bookmakers[0].markets[0].last_update='2026-09-30T01:00:00Z';
  assert.equal(quote(record,stale,now),null);
  const missing=structuredClone(event);missing.bookmakers[0].markets[0].outcomes.pop();
  assert.equal(quote(record,missing,now),null);
});

test('locks only the 2.5 goal line and never changes an existing 1/X/2 quote',()=>{
  const fixture={...record,goalsForecast:{predictedAt:'2026-09-30T09:30:00Z',probs:{over25:.58,btts:.53}}};
  const withTotals=structuredClone(event);
  withTotals.bookmakers[0].markets.push({key:'totals',last_update:'2026-10-01T09:55:00Z',outcomes:[
    {name:'Over',point:1.5,price:1.30},{name:'Under',point:1.5,price:3.7},
    {name:'Over',point:2.5,price:2.0},{name:'Under',point:2.5,price:1.85}]});
  const total=quoteTotals25(fixture,withTotals,now);
  assert.deepEqual(total.odds,[2,1.85]);assert.equal(total.pick,'Over');
  const original=attachSnapshots({version:1,records:[record]},{[record.league]:[event]},now).ledger.records[0];
  const result=attachSnapshots({version:1,records:[{...original,goalsForecast:fixture.goalsForecast}]},{[record.league]:[withTotals]},'2026-10-01T10:01:00Z');
  assert.equal(result.attached,0);assert.equal(result.totalsAttached,1);
  assert.deepEqual(result.ledger.records[0].oddsSnapshot,original.oddsSnapshot);
  assert.equal(result.ledger.records[0].totals25Snapshot.pick,'Over');
  assert.equal(quoteTotals25(fixture,withTotals,fixture.kickoffUtc),null);
});

test('coverage distinguishes fixture, bookmaker totals and valid 2.5 quote',()=>{
  const fixture={...record,goalsForecast:{predictedAt:'2026-09-30T09:30:00Z',probs:{over25:.58,btts:.53}}};
  const withTotals=structuredClone(event);
  withTotals.bookmakers[0].markets.push({key:'totals',last_update:'2026-10-01T09:55:00Z',outcomes:[
    {name:'Over',point:2.5,price:2.0},{name:'Under',point:2.5,price:1.85}]});
  const ledger={records:[fixture,{...fixture,id:2,home:'Chelsea FC'}]};
  const c=diagnoseCoverage(ledger,{[record.league]:[withTotals]},now).total;
  assert.deepEqual(c,{forecasts:2,matched:1,h2h:1,totals:1,line25:1,valid25:1});
  const missing=structuredClone(withTotals);missing.bookmakers[0].markets.pop();
  assert.deepEqual(diagnoseCoverage(ledger,{[record.league]:[missing]},now).total,
    {forecasts:2,matched:1,h2h:1,totals:0,line25:0,valid25:0});
});

test('latest quotes change while the first paper quote remains locked',()=>{
  const fixture={...record,goalsForecast:{predictedAt:'2026-09-30T09:30:00Z',probs:{over25:.58,btts:.53}}};
  const firstEvent=structuredClone(event);
  firstEvent.bookmakers[0].markets.push({key:'totals',last_update:'2026-10-01T09:55:00Z',outcomes:[
    {name:'Over',point:2.5,price:2.0},{name:'Under',point:2.5,price:1.85}]});
  const initial=attachSnapshots({records:[fixture]},{[record.league]:[firstEvent]},now).ledger;
  const latest1=updateLatestQuotes(initial,{[record.league]:[firstEvent]},now);
  assert.equal(latest1.updated,1);
  assert.equal(latest1.ledger.records[0].latestTotals25Snapshot.pick,'Over');
  const nextEvent=structuredClone(firstEvent);
  nextEvent.bookmakers[0].markets[0].last_update='2026-10-01T11:55:00Z';
  nextEvent.bookmakers[0].markets[0].outcomes[1].price=3.0;
  nextEvent.bookmakers[0].markets[1].last_update='2026-10-01T11:55:00Z';
  nextEvent.bookmakers[0].markets[1].outcomes[0].price=1.5;
  const later=updateLatestQuotes(latest1.ledger,{[record.league]:[nextEvent]},'2026-10-01T12:00:00Z');
  assert.equal(later.updated,1);
  assert.equal(later.ledger.records[0].latestOddsSnapshot.odds[1],3);
  assert.equal(later.ledger.records[0].latestTotals25Snapshot.pick,null);
  assert.deepEqual(later.ledger.records[0].oddsSnapshot,initial.records[0].oddsSnapshot);
  assert.deepEqual(later.ledger.records[0].totals25Snapshot,initial.records[0].totals25Snapshot);
  assert.equal(updateLatestQuotes(later.ledger,{[record.league]:[]},'2026-10-01T13:00:00Z').updated,0);
});
