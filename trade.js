// TRADERXY MERGED — requires BOTH tom pattern + volatility to enter
const APP_ID=1089,TOKEN="tUgDTQ6ZclOuNBl",SYMBOL="stpRNG";
const BASE_STAKE=1,DURATION=15,UNIT="s";
const CANDLE_COUNT=4; // set to 3 or 4
const HISTORY=CANDLE_COUNT*15+1;
const MODE="reversion";

const WS_URL=`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const WSClass=globalThis.WebSocket||(typeof require!=="undefined"&&require("ws"));
if(!WSClass)throw new Error("No WebSocket");
let ws=new WSClass(WS_URL);

/* === State === */
let stake=BASE_STAKE,tradeReady=false;
let contracts={},active={},results={},ticks=[];
let isAuth=false,gotProps=false,buying=false,subTicks=false;
let entryPrice=null,armed=false; // NEW

/* === Helpers === */
const send=m=>ws.readyState===1?ws.send(JSON.stringify(m)):setTimeout(()=>send(m),100);
const reset=()=>{contracts={};active={};results={};buying=gotProps=false;entryPrice=null;armed=false;};
const candles=t=>{let c=[];for(let i=0;i+14<t.length;i+=15){let s=t.slice(i,i+15);c.push({o:s[0].quote,c:s[14].quote,h:Math.max(...s.map(x=>x.quote)),l:Math.min(...s.map(x=>x.quote))});}return c;};

/* === Flow === */
ws.onopen=()=>send({ticks_history:SYMBOL,count:HISTORY,end:"latest",style:"ticks"});
ws.onmessage=e=>{
  let d=JSON.parse(e.data);if(d.error)return console.error("❌",d.error.message);
  switch(d.msg_type){
    case"history":
      ticks=d.history.prices.map((p,i)=>({epoch:d.history.times[i],quote:p}));
      console.log(`📊 Hx=${ticks.length}`);
      checkEntry();
      break;
    case"tick":
      ticks.push({epoch:d.tick.epoch,quote:d.tick.quote});
      if(ticks.length>HISTORY)ticks.shift();
      console.log(`💹 Tk=${d.tick.quote}`);

      if(!tradeReady) checkEntry();
      else if(armed && !buying) checkThreshold(d.tick.quote); // NEW
      break;

    case"authorize":
      isAuth=true;console.log("🔑 Auth");
      send({profit_table:1,limit:2,sort:"DESC"});
      break;

    case"profit_table":
      console.log("📑 PT");
      stake=BASE_STAKE;
      requestProps();
      break;

    case"proposal":
      let t=d.echo_req.contract_type,id=d.proposal?.id;
      if(t&&id){
        contracts[t]=id;
        console.log(`📜 Prop ${t}=${id}`);
      }
      break;

    case"buy":
      let id2=d.buy?.contract_id;
      if(!id2)return;
      let type=(d.echo_req.buy===contracts.CALL)?"CALL":"PUT";
      active[type]=id2;
      console.log(`🛒 Buy ${type}=${id2}`);
      send({proposal_open_contract:1,contract_id:id2,subscribe:1});
      break;

    case"proposal_open_contract":
      let poc=d.proposal_open_contract;
      if(poc?.is_sold){
        results[poc.contract_type]=+poc.profit;
        console.log(`📈 POC ${poc.contract_type}=${poc.profit}`);
        if(results.CALL!=null||results.PUT!=null) final(); // only one side possible now
      }
      break;
  }
};

/* === Entry check === */
function checkEntry(){
  let c=candles(ticks);if(c.length<CANDLE_COUNT)return;
  let last=c.slice(-CANDLE_COUNT),
    vols=last.map(x=>Math.abs(x.c-x.o)),
    avg=vols.reduce((a,b)=>a+b)/vols.length,
    min=Math.min(...vols),
    vol=avg==0;

  console.log(`🔎 vols=${vols.map(v=>v.toFixed(2))} avg=${avg.toFixed(2)} min=${min.toFixed(2)} using=${CANDLE_COUNT}`);

  if(vol){
    entryPrice=ticks[ticks.length-1].quote; // store entry price
    console.log(`🚀 Entry armed at ${entryPrice}`);
    tradeReady=true;
    armed=true;
    if(!isAuth) send({authorize:TOKEN});
    else if(!gotProps) send({profit_table:1,limit:2,sort:"DESC"});
  }
  if(!subTicks){send({ticks:SYMBOL,subscribe:1});subTicks=true;}
}

/* === Threshold logic === */
function checkThreshold(price){
  if(entryPrice==null)return;
  if(price>=entryPrice+0.2 && contracts.CALL){
    console.log(`📈 Threshold hit: CALL @ ${price} (entry ${entryPrice})`);
    buying=true;
    send({buy:contracts.CALL,price:stake});
  }
  else if(price<=entryPrice-0.2 && contracts.PUT){
    console.log(`📉 Threshold hit: PUT @ ${price} (entry ${entryPrice})`);
    buying=true;
    send({buy:contracts.PUT,price:stake});
  }
}

/* === Proposals === */
function requestProps(){
  if(gotProps)return;
  gotProps=true;
  ["CALL","PUT"].forEach(x=>
    send({proposal:1,amount:stake,basis:"stake",contract_type:x,currency:"USD",duration:DURATION,duration_unit:UNIT,symbol:SYMBOL})
  );
}

/* === Final eval with Martingale === */
function final(){
  let net=(results.CALL||0)+(results.PUT||0);
  if(net>0){
    console.log(`✅ NET=${net.toFixed(2)} | Reset to base`);
    stake=BASE_STAKE;
  } else {
    console.log(`❌ NET=${net.toFixed(2)} | Martingale applied`);
    stake*=1.1;
  }
  reset();
  requestProps();
}
