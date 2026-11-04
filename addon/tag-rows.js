/* Native Thunderbird tags. Mail is changed only by an explicit checkbox action. */
var ThunderdexTagRows = class {
  constructor(services){this.services=services;this.documents=new Map();}
  attach(pane,attempt=0){
    if(pane.closed||this.documents.has(pane.document))return;
    if(!pane.threadTree||!pane.threadPane){if(attempt<40)pane.setTimeout(()=>this.attach(pane,attempt+1),150);return;}
    const doc=pane.document;
    const css=`
      #threadTree .thunderdex-tag-list{display:inline-flex;align-items:center;gap:4px;flex:none;max-inline-size:58%;overflow:hidden;margin-inline:3px 5px;vertical-align:middle}
      #threadTree .thunderdex-tag-chip{display:inline-flex;align-items:center;flex:none;min-height:18px;max-width:140px;border-radius:5px;border:1px solid color-mix(in srgb,var(--chip-color) 28%,transparent);background:color-mix(in srgb,var(--chip-color) 17%,transparent);color:var(--chip-color);font:500 10.5px/1.3 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 6px;cursor:pointer}
      #threadTree .thunderdex-tag-add{flex:none;width:21px;height:20px;border:0;border-radius:5px;padding:0;background:transparent;color:#c4c8d0;font:16px/20px system-ui;opacity:.38;cursor:pointer}
      #threadTree tr:hover .thunderdex-tag-add,#threadTree .thunderdex-tag-add:focus-visible{opacity:1;background:#ffffff10}
      #threadTree .thunderdex-tag-chip:hover{filter:brightness(1.16)}
      #threadTree .subject-line>span,#threadTree .correspondentcol-column{color:var(--gmail-text,#e8eaed)!important}
      .thunderdex-tag-popup{position:fixed;inset:auto;margin:0;padding:12px;min-width:220px;max-width:300px;border:1px solid #464646;border-radius:10px;background:#252525;color:#ececec;box-shadow:0 10px 28px #0007;font:13px system-ui}
      .thunderdex-tag-popup h3{font:600 13px system-ui;margin:0 0 8px}
      .thunderdex-tag-choice{display:flex;align-items:center;gap:9px;cursor:pointer;padding:7px 5px;border-radius:5px;margin:0}
      .thunderdex-tag-choice:hover{background:#ffffff0b}
      .thunderdex-tag-choice input{width:auto;margin:0;accent-color:#a8c7fa}
      .thunderdex-tag-dot{width:10px;height:10px;border-radius:3px;flex:none}
      .thunderdex-tag-popup .tag-error{font-size:12px;color:#ffb4b4;white-space:normal;margin-top:6px}
    `;
    const sheet='data:text/css;charset=utf-8,'+encodeURIComponent(css);
    pane.windowUtils.loadSheetUsingURIString(sheet,Ci.nsIDOMWindowUtils.USER_SHEET);
    const popup=doc.createElement('div');popup.className='thunderdex-tag-popup';popup.setAttribute('popover','auto');popup.setAttribute('role','group');popup.setAttribute('aria-label','Étiquettes du message');doc.body.appendChild(popup);
    const info={pane,doc,sheet,popup,pending:false,stopped:false};
    const schedule=()=>{if(info.pending||info.stopped)return;info.pending=true;pane.requestAnimationFrame(()=>{info.pending=false;if(!info.stopped)this.render(info);});};
    info.observer=new pane.MutationObserver(records=>{
      if(records.every(r=>r.target.closest?.('.thunderdex-tag-list')))return;
      schedule();
    });
    info.observer.observe(pane.threadTree,{childList:true,subtree:true,attributes:true,attributeFilter:['data-properties']});
    info.click=event=>{
      const button=event.target.closest?.('.thunderdex-tag-chip,.thunderdex-tag-add');if(!button)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(event.button!==undefined&&event.button!==0)return;
      const row=button.closest('tr');if(!Number.isInteger(row?.index)||row.index<0)return;
      const header=pane.gDBView?.getMsgHdrAt(row.index);if(!header?.folder)return;
      this.open(info,header,button);
    };
    pane.threadTree.addEventListener('click',info.click,true);
    this.documents.set(doc,info);doc.body.dataset.thunderdexTags='ready';
    this.render(info);
    pane.addEventListener('unload',()=>this.detach(doc),{once:true});
  }
  tags(){return this.services.tags.getAllTags().map(t=>({key:t.key,label:t.tag,color:/^#[0-9a-f]{6}$/i.test(t.color)?t.color:'#b6b6b6'}));}
  keys(header){return new Set(header.getStringProperty('keywords').split(/\s+/).filter(Boolean));}
  render(info){
    const tags=this.tags(),version=tags.map(t=>t.key+t.label+t.color).join('|');
    for(const row of info.pane.threadTree.querySelectorAll('tbody tr.table-layout')){
      const line=row.querySelector('.subject-line');if(!line)continue;
      if(!Number.isInteger(row.index)||row.index<0||(row.dataset.properties||'').split(' ').includes('dummy')){line.querySelector('.thunderdex-tag-list')?.remove();continue;}
      let header;try{header=info.pane.gDBView?.getMsgHdrAt(row.index);}catch{continue;}
      if(!header?.folder)continue;
      const keys=this.keys(header),signature=header.folder.URI+':'+header.messageKey+'|'+[...keys].sort().join(' ')+'|'+version;
      let list=line.querySelector('.thunderdex-tag-list');
      if(list?.dataset.signature===signature)continue;
      if(!list){list=info.doc.createElement('div');list.className='thunderdex-tag-list';list.setAttribute('aria-label','Étiquettes');const subject=Array.from(line.children).find(c=>c.localName==='span');line.insertBefore(list,subject||null);}
      list.dataset.signature=signature;list.replaceChildren();
      const assigned=tags.filter(t=>keys.has(t.key));
      for(const tag of assigned.slice(0,3)){
        const chip=info.doc.createElement('button');chip.type='button';chip.className='thunderdex-tag-chip';chip.textContent=tag.label;chip.style.setProperty('--chip-color',tag.color);chip.title=tag.label+' · Modifier les étiquettes';chip.setAttribute('aria-label',chip.title);chip.tabIndex=-1;list.appendChild(chip);
      }
      const add=info.doc.createElement('button');add.type='button';add.className='thunderdex-tag-add';add.textContent=assigned.length>3?'+'+(assigned.length-3):'＋';add.title='Ajouter ou retirer une étiquette';add.setAttribute('aria-label',add.title);add.tabIndex=-1;list.appendChild(add);
    }
  }
  open(info,header,anchor){
    const popup=info.popup,keys=this.keys(header);
    const preferred=['Action requise','En attente','Important','Administratif','Factures','Personnel'];
    const all=this.tags();const tags=preferred.map(name=>all.find(t=>t.label===name)).filter(Boolean);
    tags.push(...all.filter(t=>keys.has(t.key)&&!preferred.includes(t.label)));
    popup.replaceChildren();const title=info.doc.createElement('h3');title.textContent='Étiquettes';popup.appendChild(title);
    // Freeze this header. A recycled/scrolling table row must never retarget a click.
    for(const tag of tags){
      const label=info.doc.createElement('label');label.className='thunderdex-tag-choice';
      const check=info.doc.createElement('input');check.type='checkbox';check.checked=keys.has(tag.key);
      const dot=info.doc.createElement('i');dot.className='thunderdex-tag-dot';dot.style.backgroundColor=tag.color;dot.setAttribute('aria-hidden','true');
      label.append(check,dot,info.doc.createTextNode(tag.label));popup.appendChild(label);
      check.addEventListener('change',()=>{
        try{
          if(!header.folder)throw new Error('Ce message a été déplacé ; rouvrir ses étiquettes.');
          if(check.checked)header.folder.addKeywordsToMessages([header],tag.key);else header.folder.removeKeywordsFromMessages([header],tag.key);
          this.render(info);
        }catch(error){check.checked=!check.checked;let message=popup.querySelector('.tag-error');if(!message){message=info.doc.createElement('div');message.className='tag-error';message.setAttribute('role','alert');popup.appendChild(message);}message.textContent=String(error.message||error);}
      });
    }
    if(!popup.matches(':popover-open'))popup.showPopover();
    const rect=anchor.getBoundingClientRect(),box=popup.getBoundingClientRect();
    popup.style.left=Math.max(8,Math.min(rect.left,info.pane.innerWidth-box.width-8))+'px';
    popup.style.top=Math.max(8,Math.min(rect.bottom+6,info.pane.innerHeight-box.height-8))+'px';
  }
  detach(doc){
    const info=this.documents.get(doc);if(!info)return;info.stopped=true;info.observer.disconnect();
    try{info.pane.threadTree.removeEventListener('click',info.click,true);info.doc.querySelectorAll('.thunderdex-tag-list').forEach(n=>n.remove());info.popup.remove();info.pane.windowUtils.removeSheetUsingURIString(info.sheet,Ci.nsIDOMWindowUtils.USER_SHEET);delete doc.body.dataset.thunderdexTags;}catch{}
    this.documents.delete(doc);
  }
  stop(){for(const doc of [...this.documents.keys()])this.detach(doc);}
};
