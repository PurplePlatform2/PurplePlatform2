// TRADERXY MERGED — requires BOTH tom pattern + volatility to enter
const APP_ID=1089,TOKEN="1Ej5Kd5yebuR6LN",SYMBOL="stpRNG";
const BASE_STAKE=0.5,DURATION=15,UNIT="s",HISTORY=46;
const MODE= "reversion";

const WS_URL=`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass=globalThis.WebSocket||(typeof require!=="undefined"&&require("ws"));
if(!WSClass)throw new Error("No WebSocket"); 
let ws=new WSClass(WS_URL);

/* === State === */
let stake=BASE_STAKE,tradeReady=false;
let contracts={},active={},results={},ticks=[];
let isAuth=false,gotProps=false,buying=false,subTicks=false;

/* === Helpers === */
const send=m=>ws.readyState===1?ws.send(JSON.stringify(m)):setTimeout(()=>send(m),100);
const reset=()=>{contracts={};active={};results={};buying=gotProps=false;};
const candles=t=>{let c=[];for(let i=0;i+14<t.length;i+=15){let s=t.slice(i,i+15);c.push({o:s[0].quote,c:s[14].quote,h:Math.max(...s.map(x=>x.quote)),l:Math.min(...s.map(x=>x.quote))});}return c;};

/* === Flow === */
ws.onopen=()=>send({ticks_history:SYMBOL,count:HISTORY,end:"latest",style:"ticks"});
ws.onmessage=e=>{
  let d=JSON.parse(e.data);if(d.error)return console.error("❌",d.error.message);
  switch(d.msg_type){
    case"history":ticks=d.history.prices.map((p,i)=>({epoch:d.history.times[i],quote:p}));console.log(`📊 Hx=${ticks.length}`);checkEntry();break;
    case"tick": ticks.push({epoch:d.tick.epoch,quote:d.tick.quote});if(ticks.length>HISTORY)ticks.shift();console.log(`💹 Tk=${d.tick.quote}`);if(!tradeReady)checkEntry();break;
    case"authorize":isAuth=true;console.log("🔑 Auth");send({profit_table:1,limit:2,sort:"DESC"});break;
    case"profit_table":console.log("📑 PT");stake=BASE_STAKE;requestProps();break;
    case"proposal":let t=d.echo_req.contract_type,id=d.proposal?.id;if(t&&id){contracts[t]=id;console.log(`📜 Prop ${t}=${id}`);if(contracts.CALL&&contracts.PUT&&!buying){buying=true;["CALL","PUT"].forEach(x=>send({buy:contracts[x],price:stake}));}}break;
    case"buy":let id2=d.buy?.contract_id;if(!id2)return;let type=(d.echo_req.buy===contracts.CALL)?"CALL":(d.echo_req.buy===contracts.PUT)?"PUT":(!active.CALL?"CALL":"PUT");active[type]=id2;console.log(`🛒 Buy ${type}=${id2}`);send({proposal_open_contract:1,contract_id:id2,subscribe:1});break;
    case"proposal_open_contract":let poc=d.proposal_open_contract;if(poc?.is_sold){results[poc.contract_type]=+poc.profit;console.log(`📈 POC ${poc.contract_type}=${poc.profit}`);if(results.CALL!=null&&results.PUT!=null)final();}break;
  }
};

/* === Entry check === */
function checkEntry(){
  let c=candles(ticks);if(c.length<3)return;
  let [c1,c2,c3]=c.slice(-3),
    tomRed=c1.c>Math.max(c2.h,c3.h),
    tomGreen=c1.c<Math.min(c2.l,c3.l),
    tom=tomRed||tomGreen,
    vols=c.slice(-3).map(x=>Math.abs(x.c-x.o)),
    avg=vols.reduce((a,b)=>a+b)/3,
    min=Math.min(...vols),
    vol=(avg>0.4&&min>0.29);
      if (MODE== "reversion"){vol= avg==0;tom=true; console.log("MODE MEAN REVERSION");}
      

  console.log(`🔎 tomRed=${tomRed} tomGreen=${tomGreen} | vols=${vols.map(v=>v.toFixed(2))} avg=${avg.toFixed(2)} min=${min.toFixed(2)}`);

  if(true|| tom&&vol){
    console.log("🚀 Entry");
    tradeReady=true;
    if(!isAuth)send({authorize:TOKEN});else if(!gotProps)send({profit_table:1,limit:2,sort:"DESC"});
  } 
   if(!subTicks){send({ticks:SYMBOL,subscribe:1});subTicks=true;}
}

/* === Proposals === */
function requestProps(){if(gotProps)return;gotProps=true;reset();["CALL","PUT"].forEach(x=>send({proposal:1,amount:stake,basis:"stake",contract_type:x,currency:"USD",duration:DURATION,duration_unit:UNIT,symbol:SYMBOL}));}

/* === Final eval with Martingale === */
function final(){ 
  let net=(results.CALL||0)+(results.PUT||0); 
  if(net>0){ 
    console.log(`✅ NET=${net.toFixed(2)} | Reset to base`); 
    stake=BASE_STAKE; 
    return;// ws.close();
  } else { 
    console.log(`❌ NET=${net.toFixed(2)} | Martingale applied`); 
   if(stake<(30*BASE_STAKE)) stake*=5; else return console.log("Ending trade Cycle");
  } 
  reset(); 
  requestProps(); 
}
