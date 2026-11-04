'use strict';
const $ = id => document.getElementById(id);
const api = (op,params={}) => browser.mailTerminal.request(op,params);
const labels = {idle:'Prêt',running:'En cours',starting:'Démarrage',approval:'Validation attendue',completed:'Terminé',failed:'Échec',interrupted:'Interrompu',inProgress:'En cours'};
const date = v => v ? new Date(typeof v === 'number' ? v*1000 : v).toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Paris'}) : '—';
let selected=null, state=null, busy=false, timer, editing=null, renderKey='', messageKey='', approvalKey='';
let streamId=null, revision=0, framePending=false, deltaBuffer=[], changeTimer, renderedChat=null;
async function stream(){
  if(!selected||document.hidden){streamId=null;await browser.mailTerminal.streamStop();return;}
  if(streamId===selected)return;
  streamId=selected;
  try{await browser.mailTerminal.streamStart(selected);}catch(e){streamId=null;error(e);}
}
function messageNode(itemId){
  const box=$('messages');let node=Array.from(box.children).find(n=>n.dataset.itemId===itemId);
  if(!node){node=el('div',undefined,'message assistant');node.dataset.itemId=itemId;node.append(el('span','Thunderdex','role'),document.createTextNode(''));box.append(node);}
  return node;
}
function appendDelta(event){
  const node=messageNode(event.itemId);
  node.lastChild.appendData(event.text);$('welcome').hidden=true;
}
function pumpText(){
  if(framePending)return;
  framePending=true;
  requestAnimationFrame(now=>{
    const box=$('messages'),follow=box.scrollHeight-box.scrollTop-box.clientHeight<100;
    deltaBuffer=deltaBuffer.filter(e=>e.chatId===selected);
    const count=deltaBuffer.reduce((sum,e)=>sum+Array.from(e.text).length,0);
    const remaining=Math.max(0,(deltaBuffer[0]?.queuedAt??now)+48-now);
    let budget=Math.max(8,Math.ceil(count/Math.max(1,remaining/16)));
    while(deltaBuffer.length&&budget>0){
      const event=deltaBuffer[0],chars=Array.from(event.text),take=Math.min(budget,chars.length);
      appendDelta({...event,text:chars.slice(0,take).join('')});budget-=take;
      if(take===chars.length)deltaBuffer.shift();else event.text=chars.slice(take).join('');
    }
    if(follow)box.scrollTop=box.scrollHeight;
    framePending=false;if(deltaBuffer.length)pumpText();
  });
}
function queueFullMessage(event){
  const node=messageNode(event.itemId),current=node.lastChild.data;
  const queued=deltaBuffer.find(e=>e.itemId===event.itemId)?.queuedAt;
  deltaBuffer=deltaBuffer.filter(e=>e.itemId!==event.itemId);
  if(event.text.startsWith(current)){
    const tail=event.text.slice(current.length);
    if(tail){deltaBuffer.push({...event,text:tail,queuedAt:queued??performance.now()});pumpText();}
  }else node.lastChild.data=event.text;
}
function showStatus(status,activity='',phase='thinking',failure=null){
  const active=['running','approval','starting'].includes(status);
  $('run-status').hidden=!active&&!failure;
  $('run-status').classList.toggle('spinning',active&&status!=='approval');
  $('activity').textContent=failure||activity||(status==='approval'?'Validation attendue':status==='starting'?'Démarrage…':'Réflexion…');
  $('run-status').dataset.phase=phase||'thinking';
  $('stop').hidden=!active;$('send').disabled=busy||active;
}
browser.mailTerminal.onChatEvent.addListener(event=>{
  if(event.chatId!==selected)return;
  if(event.kind==='delta'){
    if(event.revision<=revision)return;
    revision=event.revision;deltaBuffer.push({...event,queuedAt:performance.now()});pumpText();
    showStatus('running','Réponse…','writing');
  }else if(event.kind==='message'){
    if(event.revision<revision)return;
    revision=event.revision;queueFullMessage(event);
  }else if(event.kind==='status'){
    showStatus(event.status,event.activity,event.phase,event.error);
    if(state?.chat?.id===selected)Object.assign(state.chat,{status:event.status,activity:event.activity,phase:event.phase,error:event.error});
    if(event.status!=='running'){clearTimeout(changeTimer);changeTimer=setTimeout(refresh,80);}
  }else if(event.kind==='paused'){
    streamId=null;
  }else if(event.kind==='snapshot'){
    if(new URLSearchParams(location.search).has('probe'))browser.mailTerminal.reportReady({streamSnapshot:true});
    if((event.chat.revision||0)>=revision){revision=event.chat.revision||0;messageKey='';render({...state,chat:event.chat});}
  }else if(event.kind==='changed'){
    if(/turn\/|request|completed/.test(event.method)){
      clearTimeout(changeTimer);changeTimer=setTimeout(refresh,80);
    }
  }else if(event.kind==='deleted'){
    selected=null;location.hash='ask';refresh();
  }else if(event.kind==='disconnected'){
    streamId=null;clearTimeout(timer);if(!document.hidden)timer=setTimeout(refresh,1500);
  }
});
function el(tag,text,cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; }
function button(text,fn) { const b=el('button',text); b.type='button';b.addEventListener('click',()=>act(fn));return b; }
function error(e) { $('error').textContent=e?.message||String(e);$('error').hidden=false; }
async function act(fn) { try{$('error').hidden=true;await fn();await refresh();}catch(e){error(e);} }
function route(){const [view,query]=location.hash.slice(1).split('?');return {view:view==='planned'?'planned':'ask',chat:new URLSearchParams(query||'').get('chat')};}
function page() {
  const r=route(),tasks=r.view==='planned'&&!r.chat;
  $('chat-page').hidden=tasks;$('tasks-page').hidden=!tasks;
  if(r.chat&&r.chat!==selected){selected=r.chat;revision=0;messageKey='';deltaBuffer=[];refresh();}
  else if(!r.chat&&r.view==='ask'&&selected){selected=null;revision=0;messageKey='';deltaBuffer=[];refresh();}
}
window.addEventListener('hashchange',page);page();
function showChat(id) { const origin=state?.chats.find(c=>c.id===id)?.origin||'ask';selected=id;messageKey='';revision=0;deltaBuffer=[];location.hash=origin+'?chat='+encodeURIComponent(id);page();refresh(); }
function render(s) {
  state=s;
  const minimum=s.capabilities?.minIntervalMinutes||1;
  for(const id of ['task-minutes'])$(id).min=minimum;
  $('frequency-hint').textContent=`Minimum : ${minimum} minute(s). Une seule exécution à la fois ; les démarrages peuvent être retardés si une analyse est encore en cours.`;
  for(const option of $('task-frequency').options)if(option.value.startsWith('interval:')&&option.value!=='interval:custom')option.disabled=Number(option.value.split(':')[1])<minimum;
  const account=s.account;
  $('account').textContent=account?.type==='chatgpt'?'Compte ChatGPT':account?.type==='apiKey'?'Compte API':'Se connecter';
  $('account').title=account?.email||account?.error||'Compte Codex';
  $('account').hidden=Boolean(account?.type);
  browser.mailTerminal.syncNavigation({chats:s.chats,page:route().view,selectedId:selected}).catch(()=>{});
  const chat=s.chat, active=chat&&['running','approval'].includes(chat.status);
  const mk=JSON.stringify(chat?.messages||[]);
  if(mk!==messageKey&&(chat?.revision||0)>=revision){
    revision=chat?.revision||0;
    deltaBuffer=deltaBuffer.filter(e=>e.revision>revision);
    const box=$('messages'), nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<100;
    if(renderedChat!==chat?.id){box.replaceChildren();renderedChat=chat?.id;}
    const keep=new Set();
    for(const [index,m] of (chat?.messages||[]).entries()){
      const key=m.itemId||m.role+':'+index;keep.add(key);
      let n=Array.from(box.children).find(node=>node.dataset.key===key||m.itemId&&node.dataset.itemId===m.itemId);
      if(!n){n=el('div',undefined,'message '+m.role);if(m.role!=='run')n.append(el('span',m.role==='user'?'Vous':'Thunderdex','role'));n.append(document.createTextNode(''));}
      n.dataset.key=key;if(m.itemId)n.dataset.itemId=m.itemId;
      if(n.lastChild.data!==m.text)n.lastChild.data=m.text;
      if(n.parentNode!==box)box.append(n);
    }
    for(const node of Array.from(box.children))if(!keep.has(node.dataset.key))node.remove();
    if(nearBottom||!messageKey)box.scrollTop=box.scrollHeight;
    messageKey=mk;
  }
  $('welcome').hidden=Boolean(chat?.messages?.length);
  showStatus(chat?.status,chat?.activity,chat?.phase,chat?.error);
  const approvals=s.approvals.filter(a=>!a.threadId||a.threadId===selected);
  const ak=JSON.stringify(approvals);
  if(ak!==approvalKey){
    approvalKey=ak;$('approvals').replaceChildren();
    for(const a of approvals){
      const box=el('div',undefined,'approval');box.append(el('strong','Validation requise'));
      const p=a.params;
      if(a.method.endsWith('/requestUserInput')){
        const answers={};
        for(const q of p.questions||[]){
          const label=el('label',q.question);let input;
          if(q.options?.length){input=el('select');for(const o of q.options)input.add(new Option(o.label,o.label));}
          else{input=el('input');input.type=q.isSecret?'password':'text';}
          label.append(input);box.append(label);answers[q.id]=input;
        }
        box.append(button('Répondre',async()=>{const values={};for(const [id,input] of Object.entries(answers))values[id]={answers:[input.value]};await api('approval.reply',{id:String(a.id),answers:values});}));
      }else{
        box.append(el('pre',p.reason||p.command||p.message||JSON.stringify(p,null,2)));
        box.append(button('Autoriser',()=>api('approval.reply',{id:String(a.id),decision:'accept'})),button('Toujours autoriser',()=>api('approval.reply',{id:String(a.id),decision:'accept',always:true})),button('Refuser',()=>api('approval.reply',{id:String(a.id),decision:'decline'})));
      }
      $('approvals').append(box);
    }
  }
  const tk=JSON.stringify(s.tasks);
  if(tk!==renderKey){renderKey=tk;renderTasks(s);}
}
function renderTasks(s){
  const list=$('task-list');list.replaceChildren();
  if(!s.tasks.length)list.append(el('p','Aucune tâche planifiée.','empty'));
  const freq={once:'Une seule fois',daily:'Chaque jour',weekly:'Chaque semaine',interval:'À intervalle régulier'};
  for(const t of s.tasks){
    const n=el('article',undefined,'task');n.append(el('h2',t.name));
    n.append(el('div',`${t.running?'En cours':t.enabled?'Activée':'En pause / terminée'} · ${freq[t.frequency]}${t.frequency==='interval'?' · '+t.minutes+' min':''} · Prochaine exécution : ${date(t.nextRun)}`,'meta'));
    n.append(el('p',t.prompt,'instructions'));
    n.append(el('div',`${{read:'Lecture seule',draft:'Brouillons sans envoi',write:'Lecture et écriture',legacy:'Autorisations existantes'}[t.actions?.mode||'legacy']} · ${t.accounts?.length||4} boîte(s) · ${scheduleText(t.schedule)}`,'meta'));
    if(t.lastStatus)n.append(el('div','Dernier état : '+(labels[t.lastStatus]||t.lastStatus),'meta'));
    const actions=el('div',undefined,'actions');
    const modify=button('Modifier',()=>openTask(t)),toggle=button(t.enabled?'Mettre en pause':'Activer',()=>api('task.toggle',{id:t.id}));
    toggle.disabled=!t.nextRun;modify.disabled=t.running;
    const run=button('Exécuter maintenant',()=>api('task.run',{id:t.id}));run.disabled=t.running;
    const remove=button('Supprimer',async()=>{if(confirm('Supprimer cette planification ? Les résultats seront conservés dans les discussions.'))await api('task.delete',{id:t.id});});remove.disabled=t.running;
    actions.append(modify,toggle,run,remove);n.append(actions);
    if(t.runs.length){
      const details=el('details');details.append(el('summary','Historique ('+t.runs.length+')'));
      for(const r of [...t.runs].reverse()){
        const row=el('div',undefined,'run');row.append(el('div',`${date(r.at)} · ${labels[r.status]||r.status}`));
        if(r.result)row.append(el('p',r.result));
        if(r.chatId)row.append(button('Ouvrir la discussion',()=>showChat(r.chatId)));
        details.append(row);
      }n.append(details);
    }
    if(t.running&&t.activeChat)actions.append(button('Voir / valider',()=>showChat(t.activeChat)));
    list.append(n);
  }
  const external=$('external-task');external.replaceChildren();
}
async function refresh(){
  clearTimeout(timer);
  if(busy){timer=setTimeout(refresh,1000);return;}
  const key=selected;
  try{const next=await api('state',{chatId:key});if(key===selected){render(next);await stream();}}catch(e){error(e);}
  if(!document.hidden)timer=setTimeout(refresh,streamId?60000:15000);
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);stream();}else refresh();});
window.addEventListener('pagehide',()=>browser.mailTerminal.streamStop());
$('composer').addEventListener('submit',async e=>{
  e.preventDefault();const text=$('prompt').value.trim();if(!text||busy)return;
  busy=true;$('send').disabled=true;$('error').hidden=true;showStatus('starting','Démarrage…');
  try{if(!selected){selected=(await api('chat.new')).id;revision=0;}await stream();await api('chat.send',{id:selected,text});$('prompt').value='';fitPrompt();}
  catch(e){error(e);}finally{busy=false;await refresh();}
});
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('send').disabled)$('composer').requestSubmit();}});
function fitPrompt(){const input=$('prompt');input.style.height='auto';input.style.height=Math.min(144,input.scrollHeight)+'px';}
$('prompt').addEventListener('input',fitPrompt);
$('stop').addEventListener('click',()=>act(()=>api('chat.stop',{id:selected})));
$('account').addEventListener('click',()=>act(async()=>{if(state?.account?.type)return;const r=await api('account.login');if(r.authUrl)await browser.mailTerminal.openLogin(r.authUrl);}));
function localDate(t){const d=new Date(t*1000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function openTask(t){
  editing=t?.id||null;$('task-heading').textContent=t?'Modifier la tâche':'Planifier une tâche';
  $('task-name').value=t?.name||'';$('task-prompt').value=t?.prompt||'';
  $('task-date').value=localDate(t?.nextRun> Date.now()/1000?t.nextRun:Date.now()/1000+3600);
  const minutes=t?.minutes||1;
  $('task-frequency').value=t?.frequency==='interval'?'interval:'+([1,5,10,15,30,60].includes(minutes)?minutes:'custom'):t?.frequency||'once';$('task-minutes').value=minutes;
  frequencyChanged();fillSettings('task',t?.schedule,t?.actions);
  const accounts=state?.capabilities?.mailboxes||[];
  $('task-accounts').replaceChildren();
  for(const [i,email] of accounts.entries()){const label=el('label',undefined,'check-line'),input=el('input');input.type='checkbox';input.value=email;input.checked=t?.accounts?t.accounts.includes(email):i<4;label.append(input,document.createTextNode(email+(i===4?' · professionnel':'')));$('task-accounts').append(label);}
  $('task-error').textContent='';$('task-dialog').showModal();
}
$('new-task').addEventListener('click',()=>openTask());
$('cancel-task').addEventListener('click',()=>$('task-dialog').close());
function frequencyChanged(){const value=$('task-frequency').value;$('interval-label').hidden=value!=='interval:custom';if(value.startsWith('interval:')&&value!=='interval:custom')$('task-minutes').value=value.split(':')[1];}
$('task-frequency').addEventListener('change',frequencyChanged);
$('task-form').addEventListener('submit',async e=>{
  e.preventDefault();const submit=e.submitter;submit.disabled=true;
  try{await api('task.save',{id:editing,name:$('task-name').value,prompt:$('task-prompt').value,nextRun:new Date($('task-date').value).getTime()/1000,frequency:$('task-frequency').value.startsWith('interval:')?'interval':$('task-frequency').value,minutes:Number($('task-minutes').value),schedule:readSettings('task').schedule,actions:readSettings('task').actions,accounts:Array.from($('task-accounts').querySelectorAll('input:checked')).map(n=>n.value)});$('task-dialog').close();await refresh();}
  catch(e){$('task-error').textContent=e.message;}finally{submit.disabled=false;}
});
refresh().then(()=>browser.mailTerminal.reportReady({ui:'graphical',brand:document.title,connected:Boolean(state?.account?.type),tasks:state?.tasks.length||0,hasComposer:Boolean($('composer')),hash:location.hash,streamingAPI:Boolean(browser.mailTerminal.onChatEvent)})).then(()=>{if(new URLSearchParams(location.search).has('probe')&&state?.chats.length)showChat(state.chats[0].id);}).catch(error);
function scheduleText(schedule){
  const names=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
  const days=schedule?.days||[0,1,2,3,4,5,6];
  return (days.length===7?'Tous les jours':days.map(i=>names[i]).join(', '))+(schedule?.window?.enabled?' · '+schedule.window.start+'–'+schedule.window.end:' · Toute la journée');
}
function fillSettings(prefix,schedule,actions){
  const names=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];$(prefix+'-days').replaceChildren();
  for(const [i,name] of names.entries()){const label=el('label',undefined,'day-option'),input=el('input');input.type='checkbox';input.value=i;input.checked=!schedule?.days||schedule.days.includes(i);label.append(input,document.createTextNode(name));$(prefix+'-days').append(label);}
  $(prefix+'-window-enabled').checked=Boolean(schedule?.window?.enabled);
  $(prefix+'-window-fields').hidden=!schedule?.window?.enabled;
  $(prefix+'-start').value=schedule?.window?.start||'09:00';$(prefix+'-end').value=schedule?.window?.end||'18:00';
  if($(prefix+'-end-date'))$(prefix+'-end-date').value=schedule?.endDate||'';
  $(prefix+'-mode').value=actions?.mode||'read';
  $(prefix+'-organize').checked=actions?.organize??true;$(prefix+'-trash').checked=Boolean(actions?.trash);$(prefix+'-send').checked=Boolean(actions?.send);
  $(prefix+'-write-options').hidden=$(prefix+'-mode').value!=='write';
}
function readSettings(prefix){return {schedule:{days:Array.from($(prefix+'-days').querySelectorAll('input:checked')).map(n=>Number(n.value)),window:{enabled:$(prefix+'-window-enabled').checked,start:$(prefix+'-start').value,end:$(prefix+'-end').value},endDate:$(prefix+'-end-date')?.value||null},actions:{mode:$(prefix+'-mode').value,organize:$(prefix+'-organize').checked,trash:$(prefix+'-trash').checked,send:$(prefix+'-send').checked}};}
for(const prefix of ['task']){
  $(prefix+'-window-enabled').addEventListener('change',()=>{$(prefix+'-window-fields').hidden=!$(prefix+'-window-enabled').checked;});
  $(prefix+'-mode').addEventListener('change',()=>{$(prefix+'-write-options').hidden=$(prefix+'-mode').value!=='write';});
}

$('delete-chat').addEventListener('click',async()=>{
  if(!selected||!confirm('Supprimer cette discussion ?'))return;
  try{const id=selected;browser.mailTerminal.streamStop();await api('chat.delete',{id});selected=null;messageKey='';renderedChat=null;location.hash=route().view==='planned'?'planned':'ask';await refresh();}catch(e){error(e);}
});
setInterval(()=>{$('delete-chat').hidden=!selected||['running','approval'].includes(state?.chat?.status);},500);
