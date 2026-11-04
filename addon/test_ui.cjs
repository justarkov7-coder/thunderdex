const {chromium}=require('playwright');
const path=require('path');
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1400,height:900},colorScheme:'dark'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
   const state={account:{type:'chatgpt'},chats:[],chat:null,tasks:[],approvals:[],capabilities:{minIntervalMinutes:1,mailboxes:['a@example.com','b@example.com','c@example.com','d@example.com']}};let prompt;
   window.fakeState=state;window.browser={mailTerminal:{syncNavigation:async()=>{},onChatEvent:{addListener:f=>window.emitChat=f},streamStart:async()=>{},streamStop:async()=>{},reportReady:async()=>{},request:async(op,p)=>{
    if(op==='state')return structuredClone({...state,chat:p.chatId?state.chat:null});
    if(op==='chat.new'){state.chat={id:'1',title:'Test',status:'idle',messages:[]};state.chats=[{id:'1',title:'Test',status:'idle'}];return{id:'1'};}
    if(op==='chat.send'){state.chat.messages=[{role:'user',text:p.text},{role:'assistant',text:'OK'}];state.chat.status='completed';return{id:'1'};}
    if(op==='task.save'){state.tasks.push({...p,id:'t',enabled:true,running:false,runs:[]});return{id:'t'};}
    if(op==='task.toggle')state.tasks[0].enabled=!state.tasks[0].enabled;
    return{};
   }}};
 });
 await page.goto('file://'+path.join(__dirname,'dashboard.html')+'#ask');
 await page.waitForTimeout(150);if(await page.locator('#account').isVisible())throw Error('Compte déjà connecté encore affiché');if(await page.locator('#new-chat').count())throw Error('Bouton du haut encore présent');if(await page.locator('#activity').isVisible())throw Error('Mention de compte encore affichée');await page.screenshot({path:path.join(__dirname,'../assistant-preview.png')});
 if(await page.locator('#composer').evaluate(n=>n.getBoundingClientRect().height)>60)throw Error('Barre trop haute');
 await page.fill('#prompt','Test');await page.click('#send');await page.waitForSelector('.message.user');
 if(await page.locator('.message').count()!==2)throw Error('Conversation non rendue');
 await page.evaluate(()=>window.emitChat({kind:'status',chatId:'1',status:'running',phase:'mcp',activity:'MCP · gmail_search_emails'}));
 if(!await page.locator('#run-status').isVisible()||!await page.locator('#activity').innerText().then(s=>s.includes('MCP')))throw Error('Phase MCP absente');
 if(await page.locator('.status-logo img').evaluate(n=>getComputedStyle(n).animationName)!=='thunderdex-spin')throw Error('Logo non animé');
 await page.evaluate(()=>{const c=window.fakeState.chat;c.messages=[{role:'user',text:'Test'}];c.revision=0;window.emitChat({kind:'snapshot',chatId:'1',chat:structuredClone(c)});window.emitChat({kind:'delta',chatId:'1',itemId:'stream',revision:1,text:'Bon'});window.emitChat({kind:'delta',chatId:'1',itemId:'stream',revision:2,text:'jour'});});
 await page.waitForTimeout(60);
 if(await page.locator('.message.assistant').innerText().then(s=>!s.endsWith('Bonjour')))throw Error('Streaming incomplet');
 await page.evaluate(()=>{window.emitChat({kind:'delta',chatId:'1',itemId:'stream',revision:3,text:'!'});const c=window.fakeState.chat;c.revision=3;c.messages.push({role:'assistant',itemId:'stream',text:'Bonjour!'});window.emitChat({kind:'snapshot',chatId:'1',chat:structuredClone(c)});});
 await page.waitForTimeout(60);
 if(await page.locator('.message.assistant').innerText().then(s=>!s.endsWith('Bonjour!')||s.includes('!!')))throw Error('Doublon de delta');
 await page.evaluate(()=>window.emitChat({kind:'status',chatId:'1',status:'completed',phase:'idle'}));
 if(await page.locator('#run-status').isVisible())throw Error('Indicateur encore actif');
 
 await page.evaluate(()=>location.hash='planned');await page.click('#new-task');
 await page.selectOption('#task-frequency','interval:1');
 if(await page.inputValue('#task-minutes')!=='1')throw Error('Minimum incorrect');
 await page.selectOption('#task-mode','write');await page.check('#task-send');
 await page.check('#task-window-enabled');await page.fill('#task-start','09:00');await page.fill('#task-end','18:00');
 await page.fill('#task-name','Tâche de test');await page.fill('#task-prompt','Aucun outil, répondre OK');
 await page.locator('#task-form button[type=submit]').click();await page.waitForSelector('.task h2');
 if(!await page.locator('#task-list').innerText().then(s=>s.includes('Tâche de test')))throw Error('Tâche manquante');
 const saved=await page.evaluate(()=>window.fakeState.tasks[0]);
 if(saved.minutes!==1||saved.frequency!=='interval'||saved.actions.mode!=='write'||!saved.actions.send||saved.accounts.length!==4||!saved.schedule.window.enabled)throw Error('Réglages perdus');
 if(await page.locator('#chat-history').count())throw Error('Ancien historique encore présent');
 await page.getByRole('button',{name:'Mettre en pause'}).click();
 if(!await page.locator('#task-list').innerText().then(s=>s.includes('En pause')))throw Error('Pause non affichée');
 if(errors.length)throw Error(errors.join(';'));
 console.log(JSON.stringify({ui:true,pageErrors:errors}));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
