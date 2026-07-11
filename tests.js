/* Strikeboard v2 test suite — run with: node tests.js
   Exercises the shared math layer plus the Freefly pure helpers.   */
const fs = require('fs');
let src = fs.readFileSync('common.js','utf8').replace('"use strict";','');
const ff = /<script>([\s\S]*?)<\/script>/g;
let helpers = '';
for (const m of fs.readFileSync('freefly.html','utf8').matchAll(ff))
  if (m[1].includes('function flyFloorPS')) helpers = m[1].replace('"use strict";','');
fs.writeFileSync('.t.js', src + helpers + `
let pass=0, fail=0;
const ok=(c,msg)=>{ if(c){pass++;} else {fail++; console.log('  ✗ '+msg);} };

buildDemoChain();
const exp = state.expiries[1], e = state.chain.get(exp), T = yearsTo(exp);

// Black-Scholes put-call parity
{ const c=bsPrice('C',100,100,0.25,0.3), p=bsPrice('P',100,100,0.25,0.3);
  ok(Math.abs(c-p-(100-100*Math.exp(-R*0.25)))<1e-5,'put-call parity (within normal-CDF approx error)'); }

// every template builds finite metrics
for (const name of Object.keys(TEMPLATE_NAMES)){
  if (name==='custom') continue;
  state.legs = buildTemplate(name, exp);
  const dts = evalDates(), pts = curve(dts.exp);
  const {maxP,maxL} = extremes(pts, dts.exp);
  ok(state.legs.length>0 && !Number.isNaN(netPremium()) && (maxP===Infinity||isFinite(maxP)) && (maxL===-Infinity||isFinite(maxL)), 'template '+name);
}

// covered call / csp bounded at stock zero; straddle unlimited up
state.legs = buildTemplate('covered_call', exp);
ok(extremes(curve(evalDates().exp), evalDates().exp).maxL !== -Infinity, 'covered call floor');
state.legs = buildTemplate('straddle', exp);
ok(extremes(curve(evalDates().exp), evalDates().exp).maxP === Infinity, 'straddle unlimited');

// probability suite
state.legs = buildTemplate('iron_condor', exp);
const pop = probPLAbove(0);
ok(pop>0.3 && pop<0.95, 'POP in sane range');
const {maxP} = extremes(curve(evalDates().exp), evalDates().exp);
ok(probPLAbove(0.5*maxP) <= pop + 1e-9, 'P(>=50%max) <= POP');
ok(probTouch(105) > probTouch(120), 'POT monotone');
ok(Math.abs(evAtExpiry()) < 60, 'IC EV near fair');

// forward vol + shift channels
state.legs = buildTemplate('calendar', exp);
const back = state.legs.find(l=>l.exp!==earliestExpiry());
ok(forwardVolForLeg(back) > 0.05, 'forward vol computes');
state.backIvShift = 0.2;
const up = positionPL(100, evalDates().exp);
state.backIvShift = 0;
ok(up > positionPL(100, evalDates().exp), 'backIvShift raises calendar');

// fly floors: exact vs dense grid, both types, broken wings, debit & credit
let floorsOK = true;
for (const t of ['C','P']) for (const K of [[95,100,105],[95,100,103],[95,100,112]]) for (const nc of [1.2,-0.4]){
  const f = flyFloorPS(t,K[0],K[1],K[2],nc)*100;
  let g=Infinity; for(let S=0.5;S<=300;S+=0.1) g=Math.min(g, flyPLT(t,S,K[0],K[1],K[2],nc));
  if (Math.abs(f-g)>1.5) floorsOK=false;
}
ok(floorsOK, 'fly floors exact (12 cases)');

// freedom solver both sides hits the debit
const q=(t,k)=>(t==='C'?e.calls:e.puts).get(k);
const fsC=freedomSpotT('C',105,110,q('C',105).iv,q('C',110).iv,T,1.2);
ok(Math.abs(spreadValueT('C',fsC,105,110,T,q('C',105).iv,q('C',110).iv)-1.2)<0.01,'call freedom solver');
const fsP=freedomSpotT('P',95,90,q('P',95).iv,q('P',90).iv,T,1.2);
ok(fsP < 100 && Math.abs(spreadValueT('P',fsP,95,90,T,q('P',95).iv,q('P',90).iv)-1.2)<0.01,'put freedom solver');
ok(freedomSpotT('C',105,110,0.2,0.2,T,5.5)===null,'unreachable -> null');

// scanners find no free lunch on fair quotes
ok(scanFliesCore(e,100,0.10,0.66,'equal').filter(x=>x.free).length===0,'no free equal flies');
ok(scanFliesCore(e,100,0.10,0.66,'broken').filter(x=>x.free).length===0,'no free broken flies');

// MC: conversion redistributes, EVs approx equal
const iv=atmIvFor(exp);
const mc=mcCompare('C',100,105,110,1.8,100,iv,T,q('C',105).iv,q('C',110).iv,3000);
ok(Math.abs(mc.evHold-mc.evLegin)<30 && mc.pConv>=0 && mc.pConv<=1,'MC EV equivalence');

console.log(fail===0 ? \`ALL \${pass} TESTS PASS\` : \`\${pass} passed, \${fail} FAILED\`);
process.exit(fail?1:0);
`);
require('child_process').execSync('node .t.js',{stdio:'inherit'});
fs.unlinkSync('.t.js');
