'use strict';
const {spawn}=require('child_process');const assert=require('node:assert/strict');const port=3489;const proc=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function player(label){const w=new WebSocket('ws://127.0.0.1:'+port+'/ws'),msgs=[];w.onmessage=e=>msgs.push(JSON.parse(e.data));return {label,w,msgs,send:x=>w.send(JSON.stringify(x)), async wait(type,pred=()=>true,timeout=26000){const since=Date.now();while(Date.now()-since<timeout){const m=msgs.find(x=>x.type===type&&pred(x));if(m)return m;await sleep(80)}throw Error(label+' waiting '+type+': '+JSON.stringify(msgs.slice(-4)))}}}
(async()=>{try{
 for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:'+port+'/health')).ok)break}catch(e){}await sleep(65)}
 const host=player('host');await new Promise(r=>host.w.onopen=r);host.send({type:'createRoom'});const code=(await host.wait('roomCreated')).code;
 const students=[];for(const [i,team] of [0,0,1,2].entries()){let p=player('student'+i);await new Promise(r=>p.w.onopen=r);p.send({type:'joinRoom',name:'Racer '+i,code,team,color:i%4});await p.wait('joined');students.push(p)}
 host.send({type:'start'});await host.wait('raceStarted');for(const st of students)st.send({type:'control',lane:0,gas:true,brake:false,nitro:false});
 // Steer first student's car toward the approaching original-style mystery box.
 let box,question,boxSeen=false;const racer=students[0];const t0=Date.now();while(Date.now()-t0<27000){const state=racer.msgs.filter(x=>x.type==='state').at(-1);box=state?.players.find(p=>p.name==='Racer 0')?.questionBox;
 if(box){boxSeen=true;racer.send({type:'control',lane:box.x/4.22,gas:true,brake:false,nitro:false})}
 question=racer.msgs.find(x=>x.type==='question');if(question)break;await sleep(180)}
 assert.ok(boxSeen,'Should see original-style mystery box on the road');assert.ok(question,'Picking up question box should open a question');
 racer.send({type:'askHelp'});const req=await students[1].wait('helpRequest');assert.equal(req.team,0);
 assert.equal(students[2].msgs.some(x=>x.type==='helpRequest'),false,'Other team must not see the request');
 students[1].send({type:'helpVote',askerId:req.askerId,requestId:req.requestId,option:2});const votes=await racer.wait('helpVotes',x=>x.votes?.length>0);assert.equal(votes.votes[0].option,2);
 racer.send({type:'answer',answer:question.question.type==='mcq'?2:question.question.type==='order'?question.question.tokens:question.question.pairs.map(x=>x.right)});const result=await racer.wait('answerResult');assert.ok(result.points>=50);
 console.log('PASS: Original box collection, one player per device, green/blue/red teams, teammate-only help request and team vote, server-verified answers.');
 host.w.close();students.forEach(s=>s.w.close());
}catch(e){console.error('FAIL:',e);process.exitCode=1}finally{proc.kill('SIGTERM');setTimeout(()=>process.exit(),150)}})();
