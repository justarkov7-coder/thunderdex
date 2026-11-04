/* Display aliases only: no server folder is renamed and no message is moved. */
var ThunderdexFolderLabels = class {
  constructor(services){this.services=services;this.documents=new Map();}
  label(folder,type=''){
    const raw=String(folder.prettyName||folder.name||'');
    if(folder.isServer)return raw;
    const name=raw.normalize('NFKC').trim().toLowerCase();
    // Gmail All Mail contains the inbox too; preserve that distinct meaning.
    if(['all mail','all messages','tous les messages'].includes(name))return 'Tous les messages';
    const kinds={inbox:'Réception',drafts:'Brouillons',sent:'Messages envoyés',trash:'Corbeille',junk:'Indésirables',queue:'Boîte d’envoi',outbox:'Boîte d’envoi',archives:'Archives',archive:'Archives',templates:'Modèles'};
    if(kinds[type])return kinds[type];
    const names={'archive':'Archives','archives':'Archives','outbox':'Boîte d’envoi','unsent messages':'Boîte d’envoi','messages en attente':'Boîte d’envoi','sent':'Messages envoyés','sent items':'Messages envoyés','envoyés':'Messages envoyés','courrier entrant':'Réception','inbox':'Réception','[gmail]':'Dossiers Gmail','facture':'Factures','factures':'Factures','paypal':'PayPal','linkedin':'LinkedIn','distrokid':'DistroKid'};
    return names[name]||raw;
  }
  attach(pane){
    const doc=pane.document,tree=doc.getElementById('folderTree');if(!tree||this.documents.has(doc))return;
    const info={pane,tree,original:new Map(),pending:false,stopped:false};
    const run=()=>{if(info.pending||info.stopped)return;info.pending=true;pane.requestAnimationFrame(()=>{info.pending=false;if(!info.stopped){this.render(info);info.observer.takeRecords();}});};
    info.observer=new pane.MutationObserver(run);info.observer.observe(tree,{childList:true,subtree:true,attributes:true,attributeFilter:['data-folder-type']});
    info.onSelect=run;tree.addEventListener('select',run);
    this.documents.set(doc,info);this.render(info);doc.body.dataset.thunderdexFolderLabels='ready';
    pane.addEventListener('unload',()=>this.detach(doc),{once:true});
  }
  render(info){
    for(const row of info.tree.querySelectorAll('li[is="folder-tree-row"]')){
      if(!row.uri||row._nameStyle==='server')continue;
      let folder;try{folder=this.services.folderLookup.getFolderForURL(row.uri);}catch{continue;}
      if(!folder||folder.isServer)continue;
      const alias=this.label(folder,row.dataset.folderType||''),label=row.nameLabel||row.querySelector('.name');
      if(!label)continue;
      const display=row._nameStyle==='both'?alias+' - '+row._serverName:alias;
      if(label.textContent!==display){
        if(!info.original.has(row))info.original.set(row,{label:label.textContent,fullName:row.fullName});
        label.textContent=display;
        if('fullName' in row)row.fullName=display;
      }
    }
    const header=info.pane.document.getElementById('threadPaneFolderName');
    const selected=info.tree.querySelector('li.selected[is="folder-tree-row"]');
    if(header&&selected?.uri){
      try{const folder=this.services.folderLookup.getFolderForURL(selected.uri);if(folder&&!folder.isServer){const alias=this.label(folder,selected.dataset.folderType||'');if(header.textContent!==alias)header.textContent=alias;}}catch{}
    }
  }
  detach(doc){
    const info=this.documents.get(doc);if(!info)return;info.stopped=true;info.observer.disconnect();info.tree.removeEventListener('select',info.onSelect);
    for(const [row,previous] of info.original){try{if(row.isConnected){const label=row.nameLabel||row.querySelector('.name');if(label)label.textContent=previous.label;if('fullName' in row)row.fullName=previous.fullName;}}catch{}}
    delete doc.body.dataset.thunderdexFolderLabels;this.documents.delete(doc);
  }
  stop(){for(const doc of [...this.documents.keys()])this.detach(doc);}
};
