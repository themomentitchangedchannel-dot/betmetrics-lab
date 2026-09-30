import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const binaryBrier=(p,yes)=>2*(p-Number(yes))**2;
export function summarizeGoals(ledger, generatedAt) {
  if(ledger?.version!==1||!Array.isArray(ledger.records))throw Error('Invalid forecast ledger');
  const rows=[];
  for(const r of ledger.records){
    const f=r.goalsForecast,q=r.totals25Snapshot;
    if(!f||!Number.isFinite(Date.parse(f.predictedAt))||Date.parse(f.predictedAt)>=Date.parse(r.kickoffUtc)||
       !Number.isFinite(f.probs?.over25)||!Number.isFinite(f.probs?.btts)||
       f.probs.over25<0||f.probs.over25>1||f.probs.btts<0||f.probs.btts>1)continue;
    const goals=r.resultGoals,done=Number.isInteger(goals?.home)&&Number.isInteger(goals?.away)&&goals.home>=0&&goals.away>=0;
    const over=done?goals.home+goals.away>2:null,btts=done?goals.home>0&&goals.away>0:null;
    const quoted=q?.bookmaker==='betsson'&&q.point===2.5&&Array.isArray(q.odds)&&q.odds.length===2&&
      q.odds.every(o=>Number.isFinite(o)&&o>1.01&&o<100)&&Number.isFinite(Date.parse(q.quotedAt))&&
      Date.parse(f.predictedAt)<Date.parse(q.quotedAt)&&Date.parse(q.quotedAt)<Date.parse(r.kickoffUtc);
    const marketP=quoted?(1/q.odds[0])/(1/q.odds[0]+1/q.odds[1]):null;
    const selected=quoted&&['Over','Under'].includes(q.pick);
    rows.push({league:r.league,done,over,btts,quoted,selected,modelOver:f.probs.over25,modelBtts:f.probs.btts,marketP,
      profit:selected&&done?(q.pick===(over?'Over':'Under')?q.odds[over?0:1]-1:-1):null});
  }
  const roll=group=>{
    const done=group.filter(r=>r.done),quoted=group.filter(r=>r.quoted),paired=done.filter(r=>r.quoted),settled=done.filter(r=>r.selected);
    const profit=settled.reduce((s,r)=>s+r.profit,0);
    return {forecasts:group.length,finished:done.length,quoted:quoted.length,selected:group.filter(r=>r.selected).length,
      settled: settled.length,profitUnits:profit,roi:settled.length?profit/settled.length:null,
      brierOver:done.length?done.reduce((s,r)=>s+binaryBrier(r.modelOver,r.over),0)/done.length:null,
      brierBtts:done.length?done.reduce((s,r)=>s+binaryBrier(r.modelBtts,r.btts),0)/done.length:null,
      paired:paired.length,brierOverPaired:paired.length?paired.reduce((s,r)=>s+binaryBrier(r.modelOver,r.over),0)/paired.length:null,
      brierMarketPaired:paired.length?paired.reduce((s,r)=>s+binaryBrier(r.marketP,r.over),0)/paired.length:null};
  };
  return {version:1,generatedAt,overall:roll(rows),byLeague:[...new Set(rows.map(r=>r.league))].sort().map(league=>({league,...roll(rows.filter(r=>r.league===league))}))};
}

async function main(){
  const root=new URL('../',import.meta.url),ledger=JSON.parse(await readFile(new URL('data/forecast-ledger.json',root),'utf8'));
  const report=summarizeGoals(ledger,new Date().toISOString());
  await writeFile(new URL('site/data/goals-report.json',root),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(`Goal markets: ${report.overall.forecasts} frozen, ${report.overall.quoted} totals 2.5 quotes, ${report.overall.finished} finished.\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
