'use strict';
/** Zero-dependency LAN/Internet-compatible classroom game server. Node.js >=18. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const PORT = +(process.env.PORT || 3000);
const ROOT = __dirname;
const ROOMS = new Map();
const MAX_PLAYERS = 90;
const MAX_ROOMS = 150;
const roomCreateHits = new Map();
const QRCode = require('./vendor/QRCode');
const QRLevel = require('./vendor/QRCode/QRErrorCorrectLevel');
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONFIG_PATH = path.join(ROOT,'questions.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const token=()=>crypto.randomBytes(22).toString('base64url');
const clean=(s,n=24)=>String(s??'').replace(/[\x00-\x1f<>]/g,'').trim().slice(0,n);
const validTeam=x=>Number.isInteger(x)&&x>=0&&x<=2;
const clone=x=>JSON.parse(JSON.stringify(x));
function sanitizeQuestion(q){
 if(!q||typeof q!=='object')throw Error('Invalid question');
 const type=['mcq','order','match'].includes(q.type)?q.type:'mcq';
 const question=clean(q.question,400), explanation=clean(q.explanation||'',500);
 if(!question)throw Error('Question text required');
 if(type==='mcq'){
  const options=(q.options||[]).map(x=>clean(x,250));const answer=Number(q.answer);
  if(options.length!==4||options.some(x=>!x)||!Number.isInteger(answer)||answer<1||answer>4)throw Error('MCQ requires four options and answer 1–4');
  return{type,question,options,answer,explanation};
 }
 if(type==='order'){
  const tokens=(q.tokens||[]).map(x=>clean(x,80));if(tokens.length<2||tokens.length>16||tokens.some(x=>!x))throw Error('Arrange needs 2–16 words');
  return{type,question,tokens,explanation};
 }
 const pairs=(q.pairs||[]).map(x=>({left:clean(x.left,90),right:clean(x.right,90)}));
 if(pairs.length<2||pairs.length>10||pairs.some(x=>!x.left||!x.right))throw Error('Match needs 2–10 pairs');
 return{type,question,pairs,explanation};
}
function validatedConfig(input){
 if(!input||!Array.isArray(input.banks)||input.banks.length!==3)throw Error('Three question banks are required');
 const banks=input.banks.map((b,i)=>{if(!Array.isArray(b)||!b.length||b.length>250)throw Error('Level '+(i+1)+' needs 1–250 questions');return b.map(sanitizeQuestion)});
 const teamNames=Array.from({length:3},(_,i)=>clean((input.teamNames||[])[i],28)||['GREEN','BLUE','RED'][i]);
 return{teamNames,banks,timer:clamp(Number(input.timer)||30,10,120),raceSeconds:clamp(Number(input.raceSeconds)||240,60,1800),questionQuota:clamp(Math.round(Number(input.questionQuota)||5),1,30),raceDistance:clamp(Number(input.raceDistance)||1200,300,10000),theme:['DAY','NIGHT','FOREST','SPACE'].includes(input.theme)?input.theme:'FOREST'};
}
config=validatedConfig(config);
function newCode(){let c;do{c=Array.from({length:6},()=>ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)]).join('')}while(ROOMS.has(c));return c}
function makeRoom(){if(ROOMS.size>=MAX_ROOMS)throw Error('Room capacity reached; please try again later.');const room={code:newCode(),hostToken:token(),host:null,players:new Map(),status:'lobby',created:Date.now(),startAt:0,endAt:0,settings:clone(config),lastSent:0};ROOMS.set(room.code,room);return room}
function safePlayer(p){return{id:p.id,name:p.name,team:p.team,color:p.color,progress:Math.round(p.progress),speed:Math.round(p.speed*3.6),lane:p.lane,points:p.points,coins:p.coins,correct:p.correct,attempted:p.attempted,questionIndex:p.questionIndex,boostUntil:p.boostUntil,questionBox:p.questionBox||null,hasQuiz:!!p.quiz,online:!!p.connection,finished:p.finished}}
function view(room){
 const players=[...room.players.values()].map(safePlayer);
 const teams=Array.from({length:3},(_,team)=>{
  const a=players.filter(x=>x.team===team);const n=a.length;
  return{team,name:room.settings.teamNames[team],count:n,avgPoints:n?Math.round(a.reduce((v,p)=>v+p.points,0)/n):0,avgProgress:n?Math.round(a.reduce((v,p)=>v+p.progress,0)/n):0,correct:a.reduce((v,p)=>v+p.correct,0),attempted:a.reduce((v,p)=>v+p.attempted,0)};
 });
 return{type:'state',code:room.code,status:room.status,serverTime:Date.now(),startAt:room.startAt,endAt:room.endAt,settings:{...room.settings,banks:undefined},players,teams};
}
function frame(data,opcode=1){const b=Buffer.from(typeof data==='string'?data:JSON.stringify(data));let head;if(b.length<126){head=Buffer.from([0x80|opcode,b.length])}else if(b.length<65536){head=Buffer.alloc(4);head[0]=0x80|opcode;head[1]=126;head.writeUInt16BE(b.length,2)}else{head=Buffer.alloc(10);head[0]=0x80|opcode;head[1]=127;head.writeBigUInt64BE(BigInt(b.length),2)}return Buffer.concat([head,b])}
function send(conn,obj){if(conn&&!conn.socket.destroyed)try{conn.socket.write(frame(obj))}catch(e){}}
function audience(room){return [room.host,...[...room.players.values()].map(p=>p.connection)].filter(Boolean)}
function broadcast(room,obj){for(const c of audience(room))send(c,obj)}
function broadcastState(room){broadcast(room,view(room))}
function removeConnection(conn){const room=conn.room;if(!room)return;
 if(conn.role==='host'&&room.host===conn)room.host=null;
 if(conn.role==='player'){const p=room.players.get(conn.playerId);if(p&&p.connection===conn){p.connection=null;p.gas=false;p.brake=false;p.nitro=false}}
 broadcastState(room)
}
function privateQuestion(p,room){if(!p.quiz||!p.connection)return;const q=p.quiz;
 send(p.connection,{type:'question',question:{type:q.data.type,question:q.data.question,options:q.data.options,tokens:q.data.tokens,pairs:q.data.pairs},index:p.questionIndex+1,total:room.settings.questionQuota,deadline:q.deadline});
}
function orderQuestion(p,room){if(p.quiz||p.questionIndex>=room.settings.questionQuota||room.status!=='racing')return;
 const bank=room.settings.banks[p.team];const i=p.questionPlan[p.questionIndex%p.questionPlan.length];const data=bank[i];
 p.quiz={data,deadline:Date.now()+room.settings.timer*1000,helpUsed:false,helpVotes:new Map(),requestId:null};p.speed=0;p.gas=false;p.nitro=false;privateQuestion(p,room)
}
function answerCorrect(q,ans){if(!q||ans==null)return false;
 if(q.type==='mcq')return Number(ans)===q.answer;
 if(q.type==='order')return Array.isArray(ans)&&ans.length===q.tokens.length&&ans.every((word,i)=>String(word)===q.tokens[i]);
 if(q.type==='match')return Array.isArray(ans)&&ans.length===q.pairs.length&&ans.every((r,i)=>String(r)===q.pairs[i].right);
 return false;
}
function resolveAnswer(p,room,answer){if(!p.quiz)return;const q=p.quiz;const correct=answerCorrect(q.data,answer),late=Date.now()>q.deadline;
 p.questionIndex++;p.attempted++;if(correct&&!late){p.correct++;p.points+=300;p.coins+=50;p.boostUntil=Date.now()+5500;p.penaltyUntil=0}else{p.penaltyUntil=Date.now()+4500}
 const info={type:'answerResult',correct:correct&&!late,correctAnswer:q.data.type==='mcq'?q.data.options[q.data.answer-1]:q.data.type==='order'?q.data.tokens.join(' '):q.data.pairs.map(x=>x.left+' → '+x.right).join(' · '),explanation:q.data.explanation||'',points:p.points,coins:p.coins};
 p.quiz=null;p.helpRequest=null;p.lastQuestionAt=Date.now();send(p.connection,info);broadcastState(room)
}
function planQuestions(bank,limit){let ids=bank.map((_,i)=>i);for(let i=ids.length-1;i>0;i--){const j=crypto.randomInt(i+1);[ids[i],ids[j]]=[ids[j],ids[i]]}const r=[];for(let i=0;i<limit;i++)r.push(ids[i%ids.length]);return r}
function startRoom(room){room.status='countdown';room.startAt=Date.now()+10500;room.endAt=room.startAt+room.settings.raceSeconds*1000;
 for(const p of room.players.values()){
  Object.assign(p,{progress:0,speed:0,points:0,coins:0,correct:0,attempted:0,questionIndex:0,quiz:null,questionPlan:planQuestions(room.settings.banks[p.team],room.settings.questionQuota),questionBox:null,lastQuestionAt:room.startAt,boostUntil:0,penaltyUntil:0,gas:false,brake:false,nitro:false,nitroEnergy:100,lane:0,finished:false,helpRequest:null});
 }
 broadcast(room,{type:'raceCountdown',startAt:room.startAt});broadcastState(room)
}
function handle(conn,msg){
 const type=msg?.type;
 if(type==='createRoom'){if(conn.room)return send(conn,{type:'error',message:'Already in a room'});const now=Date.now(),ip=conn.ip||'unknown';const prev=roomCreateHits.get(ip)||[];const recent=prev.filter(t=>now-t<3600000);if(recent.length>=12)return send(conn,{type:'error',message:'Too many rooms created. Please try later.'});recent.push(now);roomCreateHits.set(ip,recent);if(ROOMS.size>=MAX_ROOMS)return send(conn,{type:'error',message:'Room capacity reached.'});const room=makeRoom();room.host=conn;conn.room=room;conn.role='host';send(conn,{type:'roomCreated',code:room.code,hostToken:room.hostToken,settings:room.settings});broadcastState(room);return}
 if(type==='resumeHost'){const room=ROOMS.get(clean(msg.code,6));if(!room||room.hostToken!==msg.hostToken)return send(conn,{type:'error',message:'Invalid teacher session'});if(room.host&&room.host!==conn)room.host.socket.end();conn.role='host';conn.room=room;room.host=conn;send(conn,{type:'hostResumed',code:room.code,settings:room.settings});broadcastState(room);return}
 if(type==='joinRoom'){
  const room=ROOMS.get(clean(msg.code,6).toUpperCase());if(!room)return send(conn,{type:'error',message:'Room not found. Check the code.'});
  const team=Number(msg.team),name=clean(msg.name,24);if(!validTeam(team)||!name)return send(conn,{type:'error',message:'Choose team 1, 2, or 3 and enter your name.'});
  if(room.status==='finished')return send(conn,{type:'error',message:'This race has finished.'});
  let p=[...room.players.values()].find(x=>x.resumeToken===msg.resumeToken);
  if(p&&p.team!==team)p=null;
  if(!p){if(room.status!=='lobby')return send(conn,{type:'error',message:'Race already started. Ask your teacher to restart.'});
   if(room.players.size>=MAX_PLAYERS)return send(conn,{type:'error',message:'Room is full.'});
   const id=crypto.randomUUID();p={id,resumeToken:token(),name,team,color:clamp(Math.floor(Number(msg.color)||0),0,3),connection:null,progress:0,speed:0,lane:0,points:0,coins:0,correct:0,attempted:0,questionIndex:0,quiz:null,questionBox:null,gas:false,brake:false,nitro:false,boostUntil:0,finished:false};room.players.set(id,p);
  }
  if(p.connection&&p.connection!==conn)p.connection.socket.end();p.connection=conn;conn.room=room;conn.role='player';conn.playerId=p.id;
  send(conn,{type:'joined',code:room.code,id:p.id,resumeToken:p.resumeToken,team:p.team,name:p.name,settings:{...room.settings,banks:undefined}});broadcastState(room);privateQuestion(p,room);return
 }
 const room=conn.room;if(!room)return send(conn,{type:'error',message:'Please join a race first.'});
 const isHost=conn.role==='host'&&room.host===conn;
 const p=conn.role==='player'?room.players.get(conn.playerId):null;
 if(type==='settings'&&isHost){if(room.status!=='lobby')return send(conn,{type:'error',message:'Settings can only change in the lobby'});try{room.settings=validatedConfig({...room.settings,...msg.settings});config=clone(room.settings);fs.writeFile(CONFIG_PATH,JSON.stringify(config,null,2),'utf8',err=>{if(err)console.warn('Could not persist game settings:',err.message)});send(conn,{type:'settingsSaved',settings:room.settings});broadcastState(room)}catch(e){send(conn,{type:'error',message:e.message})}return}
 if(type==='start'&&isHost){if(room.status!=='lobby')return send(conn,{type:'error',message:'Return to lobby before starting again'});if(!room.players.size)return send(conn,{type:'error',message:'At least one student needs to join'});startRoom(room);return}
 if(type==='reset'&&isHost){room.status='lobby';room.startAt=0;room.endAt=0;for(const p of room.players.values()){p.quiz=null;p.questionBox=null;p.progress=0;p.points=0;p.correct=0;p.attempted=0;p.questionIndex=0;p.speed=0;p.finished=false};broadcast(room,{type:'reset'});broadcastState(room);return}
 if(type==='kick'&&isHost){const x=room.players.get(String(msg.id));if(x){send(x.connection,{type:'error',message:'Removed by teacher'});x.connection?.socket.end();room.players.delete(x.id);broadcastState(room)}return}

 if(type==='askHelp'&&p&&room.status==='racing'){
  if(!p.quiz)return send(conn,{type:'helpStatus',message:'Open a question first.'});
  if(p.quiz.helpUsed)return send(conn,{type:'helpStatus',message:'You already asked for help on this question.'});
  const teammates=[...room.players.values()].filter(x=>x.team===p.team&&x.id!==p.id&&x.connection);
  if(!teammates.length)return send(conn,{type:'helpStatus',message:'No other teammates are online right now.'});
  p.quiz.helpUsed=true;p.quiz.deadline+=12000; // enough extra time for a teammate to suggest an answer
  const requestId=token();p.quiz.requestId=requestId;
  const req={type:'helpRequest',requestId,askerId:p.id,askerName:p.name,team:p.team,question:{type:p.quiz.data.type,question:p.quiz.data.question,options:p.quiz.data.options||[]},expiresAt:Date.now()+12000};
  for(const t of teammates)send(t.connection,req);
  send(conn,{type:'helpVotes',votes:[],deadline:p.quiz.deadline});
  if(room.host)send(room.host,{type:'helpActivity',team:p.team,askerName:p.name});
  return;
 }
 if(type==='helpVote'&&p&&room.status==='racing'){
  const asker=room.players.get(String(msg.askerId));if(!asker?.quiz||asker.id===p.id||asker.team!==p.team)return;
  const question=asker.quiz;if(!question.helpUsed||question.requestId!==msg.requestId||Date.now()>question.deadline)return;
  const maxOption=question.data.type==='mcq'?4:3;
  const vote=Number(msg.option);if(!Number.isInteger(vote)||vote<1||vote>maxOption)return;
  if(question.helpVotes.has(p.id))return;
  question.helpVotes.set(p.id,vote);
  const tally=[...question.helpVotes.values()].reduce((acc,k)=>(acc.set(k,(acc.get(k)||0)+1),acc),new Map());
  const votes=[...tally].map(([option,count])=>({option,count})).sort((a,b)=>b.count-a.count||a.option-b.option);
  send(asker.connection,{type:'helpVotes',votes,deadline:question.deadline});
  send(conn,{type:'helpStatus',message:'Your suggestion was sent.'});
  return;
 }
 if(type==='control'&&p&&room.status==='racing'&&!p.quiz){p.gas=!!msg.gas;p.brake=!!msg.brake;p.nitro=!!msg.nitro;p.lane=clamp(Number(msg.lane)||0,-1,1);return}
 if(type==='answer'&&p&&room.status==='racing'){resolveAnswer(p,room,msg.answer);return}
 if(type==='leave'&&p){room.players.delete(p.id);conn.room=null;conn.role=null;conn.playerId=null;broadcastState(room);return}
 if(type==='ping')send(conn,{type:'pong'});
}
let previous=Date.now();setInterval(()=>{
 const now=Date.now();const dt=clamp((now-previous)/1000,0,.35);previous=now;
 for(const room of ROOMS.values()){
  if(room.status==='countdown'){if(now<room.startAt)continue;room.status='racing';broadcast(room,{type:'raceStarted',startAt:room.startAt});broadcastState(room)}
  if(room.status!=='racing')continue;
  let allDone=room.players.size>0;
  for(const p of room.players.values()){
   if(p.quiz&&now>=p.quiz.deadline){resolveAnswer(p,room,null)}
   if(p.finished)continue;
   if(p.quiz){p.speed=0;allDone=false;continue}
   if(p.questionIndex<room.settings.questionQuota&&now-p.lastQuestionAt>=9000&&!p.questionBox){
     p.questionBox={z:Math.round(p.progress+74),x:[-4.22,0,4.22][crypto.randomInt(3)]};
   }
   // Follow the original game: the player must physically collect the mystery box.
   if(p.questionBox){const box=p.questionBox, laneX=p.lane*4.22;
     if(Math.abs(p.progress-box.z)<3.8 && Math.abs(laneX-box.x)<1.65){p.questionBox=null;p.points+=50;orderQuestion(p,room);allDone=false;continue}
     if(p.progress>box.z+5){p.questionBox=null;p.lastQuestionAt=now-6000}
   }
   if(p.questionIndex<room.settings.questionQuota)allDone=false;

   const boost=p.boostUntil>now;const penalty=p.penaltyUntil>now;
   const base=p.gas?17:10;const target=p.brake?3:boost&&p.nitro?33:boost?26:penalty?6:base;
   p.speed=clamp(p.speed+(target-p.speed)*Math.min(1,dt*2.3),0,34);
   p.progress=p.questionIndex<room.settings.questionQuota?p.progress+p.speed*dt:Math.min(room.settings.raceDistance,p.progress+p.speed*dt);
   if(p.progress>=room.settings.raceDistance&&p.questionIndex>=room.settings.questionQuota){p.finished=true;p.speed=0;p.points+=100;p.coins+=20;send(p.connection,{type:'playerFinished'})}
   else allDone=false;
  }
  if(now>=room.endAt||allDone){room.status='finished';broadcast(room,{type:'finished',teams:view(room).teams,players:view(room).players,status:'finished'});broadcastState(room)}
  else if(now-room.lastSent>250){room.lastSent=now;broadcastState(room)}
 }
 for(const [code,room] of ROOMS){if(Date.now()-room.created>12*3600_000||room.status==='finished'&&now-room.endAt>2*3600_000)ROOMS.delete(code)}
 if(roomCreateHits.size>1000)for(const [ip,arr] of roomCreateHits){const recent=arr.filter(t=>now-t<3600000);if(!recent.length)roomCreateHits.delete(ip);else roomCreateHits.set(ip,recent)}
},100);
const ALLOWED=new Map([['/','index.html'],['/index.html','index.html'],['/classic','classic.html'],['/classic.html','classic.html'],['/questions_template.csv','questions_template.csv']]);
const TYPES={'.html':'text/html; charset=utf-8','.csv':'text/csv; charset=utf-8'};
const server=http.createServer((req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('X-Frame-Options','DENY');
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/qr.svg'){
  const link=new URL(req.url,'http://localhost').searchParams.get('value')||'';
  if(link.length>350||!/^https?:\/\/[^\s]+$/i.test(link)){res.writeHead(400,{'Content-Type':'text/plain'});return res.end('Invalid QR link')}
  try{const qr=new QRCode(0,QRLevel.M);qr.addData(link);qr.make();const n=qr.getModuleCount(),margin=4;const rects=[];for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(qr.isDark(y,x))rects.push('<rect x=\"'+(x+margin)+'\" y=\"'+(y+margin)+'\" width=\"1\" height=\"1\"/>');
   const side=n+margin*2;res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});return res.end('<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 '+side+' '+side+'\" shape-rendering=\"crispEdges\" width=\"270\" height=\"270\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><g fill=\"#07182c\">'+rects.join('')+'</g></svg>')}catch(e){res.writeHead(400,{'Content-Type':'text/plain'});return res.end('QR generation failed')}
 }
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:ROOMS.size}))}
 if(pathname==='/network-info'){
  const addresses=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address);
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
  return res.end(JSON.stringify({addresses,port:PORT}));
 }
 const file=ALLOWED.get(pathname);if(!file){res.writeHead(404);return res.end('Not Found')}
 fs.readFile(path.join(ROOT,file),(err,data)=>{if(err){res.writeHead(500);return res.end('File error')};res.writeHead(200,{'Content-Type':TYPES[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(data)})
});
server.on('upgrade',(req,socket,head)=>{
 let url;try{url=new URL(req.url,'http://localhost')}catch(e){socket.destroy();return}
 if(url.pathname!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!req.headers['sec-websocket-key']){socket.destroy();return}
 // Protect upgrades against scripts embedded on third-party websites.
 const origin=req.headers.origin;const host=req.headers.host;
 if(origin){try{const o=new URL(origin);if(o.host!==host){socket.destroy();return}}catch(e){socket.destroy();return}}
 const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 const conn={socket,ip:String(req.headers['x-forwarded-for']||socket.remoteAddress||'unknown').split(',')[0].trim().slice(0,90),role:null,room:null,playerId:null,buffer:Buffer.alloc(0),messages:0,quotaTime:Date.now()};
 socket.on('data',chunk=>{
  conn.buffer=Buffer.concat([conn.buffer,chunk]);if(conn.buffer.length>2_000_000)return socket.destroy();
  while(conn.buffer.length>=2){let b=conn.buffer,opcode=b[0]&15,masked=!!(b[1]&128),len=b[1]&127,at=2;
   if(len===126){if(b.length<4)break;len=b.readUInt16BE(2);at=4}else if(len===127){if(b.length<10)break;const n=b.readBigUInt64BE(2);if(n>BigInt(1_000_000))return socket.destroy();len=Number(n);at=10}
   if(!masked)return socket.destroy();if(b.length<at+4+len)break;
   const mask=b.subarray(at,at+4);const data=Buffer.from(b.subarray(at+4,at+4+len));for(let i=0;i<len;i++)data[i]^=mask[i%4];conn.buffer=b.subarray(at+4+len);
   if(opcode===8){socket.end();return}if(opcode===9){socket.write(frame(data,10));continue}if(opcode!==1)continue;
   const now=Date.now();if(now-conn.quotaTime>1000){conn.quotaTime=now;conn.messages=0}if(++conn.messages>70)return socket.destroy();
   try{handle(conn,JSON.parse(data.toString('utf8')))}catch(e){send(conn,{type:'error',message:'Invalid message'})}
  }
 });
 socket.on('error',()=>{});socket.on('close',()=>removeConnection(conn));if(head.length)socket.emit('data',head);
});
server.listen(PORT,'0.0.0.0',()=>console.log(`🏎️  Asmaa Car Racing running at http://localhost:${PORT}\nPublic hosting: share the HTTPS URL; students may use different Internet networks.`));
