const fs=require('fs');const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1050,height:600},colorScheme:'dark'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{background:#171717;color:#ececec;font:14px system-ui;padding:30px}table{width:100%;border-collapse:collapse}td{padding:12px 8px;border-bottom:1px solid #333}.subject-line{display:flex;align-items:center;gap:4px}.subject-line>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}</style><table id="threadTree"><tbody><tr class="table-layout"><td><div class="subject-line"><img><span>Réponse attendue</span></div></td></tr><tr class="table-layout"><td><div class="subject-line"><img><span>Facture de votre hébergement</span></div></td></tr></tbody></table>');
 await page.addScriptTag({content:fs.readFileSync(__dirname+'/tag-rows.js','utf8')});
 await page.evaluate(()=>{
  window.Ci={nsIDOMWindowUtils:{USER_SHEET:1}};window.windowUtils={loadSheetUsingURIString(uri){const s=document.createElement('style');s.textContent=decodeURIComponent(uri.slice(uri.indexOf(',')+1));document.head.append(s)},removeSheetUsingURIString(){}};
  const folder={URI:'imap://test',addKeywordsToMessages(headers,key){headers.forEach(h=>h.words.add(key))},removeKeywordsFromMessages(headers,key){headers.forEach(h=>h.words.delete(key))}};
  window.headers=[{folder,messageKey:1,words:new Set(['important','internal']),read:false,getStringProperty(){return [...this.words].join(' ')}},{folder,messageKey:2,words:new Set(),read:false,getStringProperty(){return [...this.words].join(' ')}}];
  window.threadTree=document.getElementById('threadTree');window.threadPane={};window.gDBView={getMsgHdrAt:i=>headers[i]};
  Array.from(threadTree.querySelectorAll('tr')).forEach((r,i)=>r.index=i);
  window.rowClicks=0;threadTree.addEventListener('click',()=>rowClicks++);
  const tags=[['action','Action requise','#E6A06E'],['waiting','En attente','#D8C47A'],['important','Important','#D88B8B'],['admin','Administratif','#85B5A0'],['bills','Factures','#82AED9'],['perso','Personnel','#B3A0D6']];
  window.controller=new ThunderdexTagRows({tags:{getAllTags:()=>tags.map(([key,tag,color])=>({key,tag,color}))}});controller.attach(window);
 });
 if(await page.locator('.thunderdex-tag-chip').count()!==1)throw Error('Existing tag missing');
 if(await page.locator('.subject-line>span').first().innerText()!=='Réponse attendue')throw Error('Native subject selector broken');
 await page.locator('.thunderdex-tag-add').first().click();await page.getByLabel('Factures',{exact:true}).check();
 if(!await page.evaluate(()=>headers[0].words.has('bills')&&headers[0].words.has('internal')&&!headers[0].read&&rowClicks===0))throw Error('Wrong message or selection/read state changed');
 await page.getByLabel('Factures',{exact:true}).uncheck();
 if(await page.evaluate(()=>headers[0].words.has('bills')))throw Error('Removal failed');
 await page.evaluate(()=>{document.querySelector('tr').index=1;controller.render(controller.documents.get(document));});
 if(await page.locator('tr').first().locator('.thunderdex-tag-chip').count())throw Error('Recycled row kept stale labels');
 // The open popup must still target the original header after row recycling.
 await page.getByLabel('Personnel',{exact:true}).check();
 if(!await page.evaluate(()=>headers[0].words.has('perso')&&!headers[1].words.has('perso')))throw Error('Popup retargeted a recycled row');
 await page.evaluate(()=>{document.querySelector('tr').index=0;controller.render(controller.documents.get(document));document.querySelector('.thunderdex-tag-popup').hidePopover();});
 await page.screenshot({path:__dirname+'/../mail-tags-preview.png'});
 if(errors.length)throw Error(errors.join(';'));
 console.log(JSON.stringify({existingTags:true,addRemove:true,readPreserved:true,noRowSelection:true,virtualizedRows:true,popupFrozenTarget:true,pageErrors:errors}));
 await page.evaluate(()=>controller.stop());if(await page.locator('.thunderdex-tag-list').count())throw Error('Cleanup failed');
 await page.addScriptTag({content:fs.readFileSync(__dirname+'/folder-labels.js','utf8')});
 const aliases=await page.evaluate(()=>{
  const tree=document.createElement('ul');tree.id='folderTree';document.body.append(tree);
  const samples=[['imap://one/INBOX','INBOX','inbox'],['imap://two/Sent','Envoyés','sent'],['imap://gmail/All','Tous les messages','archives'],['imap://one/Archive','Archive',''],['imap://one/Personnel','Personnel','']];
  const folders={};for(const [uri,name,type] of samples){folders[uri]=Object.freeze({URI:uri,prettyName:name,isServer:false});const row=document.createElement('li');row.setAttribute('is','folder-tree-row');row.uri=uri;row._nameStyle='folder';row.dataset.folderType=type;const label=document.createElement('span');label.className='name';label.textContent=name;row.nameLabel=label;row.append(label);tree.append(row);}
  const labels=new ThunderdexFolderLabels({folderLookup:{getFolderForURL:uri=>folders[uri]}});labels.attach(window);
  const names=Array.from(tree.querySelectorAll('.name')).map(n=>n.textContent);labels.stop();const restored=Array.from(tree.querySelectorAll('.name')).map(n=>n.textContent);
  return{names,restored,underlying:samples.map(([uri])=>folders[uri].prettyName)};
 });
 if(JSON.stringify(aliases.names)!==JSON.stringify(['Réception','Messages envoyés','Tous les messages','Archives','Personnel']))throw Error('Aliases incorrects');
 if(JSON.stringify(aliases.restored)!==JSON.stringify(aliases.underlying))throw Error('Alias changed folders or failed cleanup');
 console.log(JSON.stringify({folderAliases:aliases.names,gmailAllMailPreserved:true,physicalFolderNamesUntouched:true,aliasCleanup:true}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
