/* Local UI: fixed private IPC client, no shell and no public listening port. */
const SOCKET_PATH = PathUtils.join(Services.dirsvc.get('Home', Ci.nsIFile).path, '.local', 'state', 'thunderdex', 'codex-ui.sock');
const {TextEncoder, TextDecoder} = Cu.getGlobalForObject(ChromeUtils.importESModule('resource://gre/modules/AppConstants.sys.mjs'));
var mailTerminal = class extends ExtensionAPI {
  getAPI(context) {
    this.listeners ??= new Set();
    return { mailTerminal: {
      start: async () => this.start(context.extension),
      request: async (op, params) => this.request(op, params),
      streamStart: async id => this.streamStart(id),
      streamStop: async () => this.streamStop(),
      syncNavigation: async data => this.syncNavigation(data),
      onChatEvent: new ExtensionCommon.EventManager({context, name:'mailTerminal.onChatEvent', register:fire=>{
        this.listeners.add(fire); return ()=>this.listeners.delete(fire);
      }}).api(),
      openLogin: async url => {
        const uri = Services.io.newURI(url);
        if (uri.scheme !== 'https' || !['auth.openai.com','auth0.openai.com','chatgpt.com'].includes(uri.host)) throw new Error('Adresse de connexion refusée.');
        Cc['@mozilla.org/uriloader/external-protocol-service;1'].getService(Ci.nsIExternalProtocolService).loadURI(uri);
      },
      reportReady: async info => Services.obs.notifyObservers(null, 'tbmail-terminal-ready', JSON.stringify(info)),
    }};
  }

  /* Direct Unix-socket IPC from Gecko: no helper process per request. */
  ipc(payload, onLine) {
    const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    file.initWithPath(SOCKET_PATH);
    const transport = Cc['@mozilla.org/network/socket-transport-service;1']
      .getService(Ci.nsISocketTransportService).createUnixDomainTransport(file);
    const output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
    const input = transport.openInputStream(0, 0, 0);
    const bytes = new TextEncoder().encode(JSON.stringify(payload) + '\n');
    if (bytes.length > 1048576) throw new Error('Requête trop longue.');
    const bin = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
    bin.setOutputStream(output); bin.writeByteArray(bytes); bin.flush();
    const decoder = new TextDecoder(); let buffer = '';
    const pump = Cc['@mozilla.org/network/input-stream-pump;1'].createInstance(Ci.nsIInputStreamPump);
    pump.init(input, 0, 0, true);
    const done = new Promise((resolve, reject) => pump.asyncRead({
      onStartRequest() {},
      onDataAvailable(req, stream, offset, count) {
        const reader = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
        reader.setInputStream(stream);
        buffer += decoder.decode(new Uint8Array(reader.readByteArray(count)), {stream: true});
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); onLine(line); }
      },
      onStopRequest(req, status) { try { transport.close(0); } catch {} Components.isSuccessCode(status) ? resolve() : reject(new Error('Le service local est indisponible.')); },
    }));
    return {done, close: () => { try { pump.cancel(Cr.NS_BINDING_ABORTED); } catch {} try { transport.close(0); } catch {} }};
  }

  async request(op, params) {
    const allowed = ['state','chat.new','chat.send','chat.stop','chat.delete','account.login','approval.reply','task.save','task.toggle','task.delete','task.run'];
    if (!allowed.includes(op)) throw new Error('Action inconnue.');
    let result = null;
    const call = this.ipc({op, params}, line => { result ??= JSON.parse(line); });
    await call.done;
    if (!result) throw new Error('Le service local est indisponible.');
    if (!result.ok) throw new Error(result.error || 'Erreur du service local.');
    return result.result;
  }

  async streamStart(id) {
    if (this.stream?.id === id) return;
    this.streamStop();
    const session = {id};
    this.stream = session;
    const fire = event => { for (const f of this.listeners) f.async(event).catch(() => {}); };
    session.call = this.ipc({op: 'chat.subscribe', params: {id}}, line => {
      try { if (this.stream === session) fire(JSON.parse(line)); } catch {}
    });
    session.call.done.catch(() => {}).finally(() => {
      if (this.stream === session) { this.stream = null; fire({kind: 'disconnected', chatId: id}); }
    });
  }

  streamStop(){
    const old=this.stream;this.stream=null;
    if(old)for(const fire of this.listeners)fire.async({kind:'paused',chatId:old.id}).catch(()=>{});
    old?.call?.close();
  }

  start(extension) {
    if (this.started) return;
    this.started = true;
    this.extension = extension;
    this.documents = new Map();
    const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
    this.tagRows=new ThunderdexTagRows(MailServices);
    this.folderLabels=new ThunderdexFolderLabels(MailServices);
    this.observer = {observe: doc => {
      if (doc.documentURI.split('?')[0] !== 'about:3pane') return;
      doc.addEventListener('DOMContentLoaded', () => this.attach(doc), {once:true});
    }};
    Services.obs.addObserver(this.observer, 'document-element-inserted');
    const inspect = doc => {
      if (doc?.documentURI.split('?')[0] === 'about:3pane') this.attach(doc);
      for (const b of doc?.querySelectorAll('browser') ?? []) { try { inspect(b.contentDocument); } catch {} }
    };
    for (const win of Services.wm.getEnumerator('mail:3pane')) inspect(win.document);
    this.request('state',{}).then(state=>this.syncNavigation({chats:state.chats})).catch(()=>{});
  }

  attach(doc) {
    this.tagRows?.attach(doc.defaultView);
    this.folderLabels?.attach(doc.defaultView);
    const sidebar = doc.getElementById('folderPane');
    if (!sidebar || doc.getElementById('tbmail-assistant-button')) return;
    const css = `
      #tbmail-assistant-nav {flex:none; display:grid; gap:2px; padding:8px 12px 14px; max-height:48vh; overflow:auto; border-top:1px solid var(--splitter-color, #333);}
      #tbmail-assistant-nav button { flex:none; margin:0; min-height:38px; padding:8px 14px; text-align:start; border-radius:8px; font:inherit; }
      #tbmail-assistant-nav .tbmail-history {display:grid; max-height:165px; overflow:auto; margin:0 0 4px 14px; gap:1px;}
      #tbmail-assistant-nav .tbmail-history:empty {display:none;}
      #tbmail-assistant-nav .tbmail-history button {min-height:28px; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:5px 8px;}
      #tbmail-assistant-nav .tbmail-history button.active {background:var(--selected-item-color,#383d48);}
      #tbmail-assistant-nav button[aria-pressed="true"] { background:var(--selected-item-color, #383d48); color:var(--selected-item-text-color, white); }
      #tbmail-assistant-view { grid-area: account-central; min-width:0; min-height:0; width:100%; height:100%; border:0; }
      body:not(.tbmail-assistant-open) #tbmail-assistant-view { display:none !important; }
      body.tbmail-assistant-open { grid-template: "folders folderPaneSplitter account-central" minmax(0,1fr) / minmax(auto,var(--folderPaneSplitter-width)) min-content minmax(0,1fr) !important; }
      body.tbmail-assistant-open :is(#threadPane,#messagePaneSplitter,#messagePane,#accountCentralBrowser) { display:none !important; }
    `;
    const sheet = 'data:text/css;charset=utf-8,' + encodeURIComponent(css);
    doc.defaultView.windowUtils.loadSheetUsingURIString(sheet, Ci.nsIDOMWindowUtils.USER_SHEET);
    const group = doc.createElement('div');
    group.id='tbmail-assistant-nav';
    const button = doc.createElement('button');
    button.id = 'tbmail-assistant-button';
    button.className = 'button button-flat';
    button.type = 'button';
    button.textContent = '✧  Ask';
    button.setAttribute('aria-pressed','false');
    button.addEventListener('click', () => this.show(doc,'ask',null,true));
    const planned=doc.createElement('button');
    planned.id='tbmail-planned-button';planned.className='button button-flat';planned.type='button';planned.textContent='◷  Planifié';planned.setAttribute('aria-pressed','false');
    planned.addEventListener('click',()=>this.show(doc,'planned'));
    const asks=doc.createElement('div'),plans=doc.createElement('div');
    asks.id='tbmail-ask-history';plans.id='tbmail-planned-history';asks.className=plans.className='tbmail-history';
    asks.setAttribute('aria-label','Historique Ask');plans.setAttribute('aria-label','Historique des tâches');
    group.append(button,asks,planned,plans);sidebar.appendChild(group);
    const close = () => {
      this.streamStop();
      const view=doc.getElementById('tbmail-assistant-view');if(view)view.docShellIsActive=false;
      doc.body.classList.remove('tbmail-assistant-open');
      button.setAttribute('aria-pressed','false');
      planned.setAttribute('aria-pressed','false');
      Services.prefs.setBoolPref('extensions.tbmail.assistant.open', false);
    };
    doc.getElementById('folderTree')?.addEventListener('select', close);
    doc.getElementById('folderTree')?.addEventListener('click', close);
    this.documents.set(doc, {sheet, close});
    if(this.navData)this.syncNavigation(this.navData);
    doc.defaultView.addEventListener('unload', () => this.documents.delete(doc), {once:true});
    if (Services.prefs.getBoolPref('extensions.tbmail.assistant.open', false)) this.show(doc,Services.prefs.getStringPref('extensions.tbmail.assistant.page','ask'));
  }

  syncNavigation(data) {
    this.navData=data;
    const signature=JSON.stringify(data);
    for(const [doc] of this.documents??[]){
      if(doc._tbmailNavSignature===signature)continue;
      doc._tbmailNavSignature=signature;
      if(data.page&&doc.body.classList.contains('tbmail-assistant-open')){
        doc.getElementById('tbmail-assistant-button').setAttribute('aria-pressed',String(data.page==='ask'));
        doc.getElementById('tbmail-planned-button').setAttribute('aria-pressed',String(data.page==='planned'));
      }
      for(const [origin,id] of [['ask','tbmail-ask-history'],['planned','tbmail-planned-history']]){
        const list=doc.getElementById(id);if(!list)continue;list.replaceChildren();
        for(const chat of (data.chats||[]).filter(c=>(c.origin||'ask')===origin)){
          if(typeof chat.id!=='string'||!/^[a-zA-Z0-9-]+$/.test(chat.id))continue;
          const item=doc.createElement('button');item.type='button';item.className='button button-flat'+(data.selectedId===chat.id?' active':'');
          item.textContent=(['running','approval'].includes(chat.status)?'• ':'')+chat.title;
          item.title=chat.title;item.dataset.chatId=chat.id;
          item.addEventListener('click',()=>this.show(doc,origin,chat.id));list.appendChild(item);
        }
      }
    }
  }

  show(doc,page='ask',chatId=null,fresh=false) {
    const hash=page+(chatId?'?chat='+encodeURIComponent(chatId):fresh?'?new='+Date.now():'');
    let frame = doc.getElementById('tbmail-assistant-view');
    if (!frame) {
      frame = doc.createXULElement('browser');
      frame.id = 'tbmail-assistant-view';
      for (const [key,value] of Object.entries({type:'content',flex:'1',disablehistory:'true',maychangeremoteness:'true',messagemanagergroup:'webext-browsers'})) frame.setAttribute(key,value);
      doc.body.appendChild(frame);
      frame.loadURI(Services.io.newURI(this.extension.baseURI.resolve('dashboard.html#'+hash)), {triggeringPrincipal:this.extension.principal});
    }
    const current=frame.browsingContext.currentWindowGlobal?.documentURI?.spec;
    if(current?.startsWith('moz-extension:')&&!current.endsWith('#'+hash)) frame.loadURI(Services.io.newURI(this.extension.baseURI.resolve('dashboard.html#'+hash)),{triggeringPrincipal:this.extension.principal});
    frame.docShellIsActive=true;
    doc.body.classList.add('tbmail-assistant-open');
    doc.getElementById('tbmail-assistant-button').setAttribute('aria-pressed',String(page==='ask'));
    doc.getElementById('tbmail-planned-button').setAttribute('aria-pressed',String(page==='planned'));
    Services.prefs.setStringPref('extensions.tbmail.assistant.page',page);
    Services.prefs.setBoolPref('extensions.tbmail.assistant.open', true);
  }

  onShutdown() {
    this.tagRows?.stop();
    this.folderLabels?.stop();
    this.streamStop();
    if (this.observer) Services.obs.removeObserver(this.observer,'document-element-inserted');
    for (const [doc, {sheet,close}] of this.documents ?? []) {
      doc.getElementById('folderTree')?.removeEventListener('select',close);
      doc.getElementById('folderTree')?.removeEventListener('click',close);
      doc.body.classList.remove('tbmail-assistant-open');
      doc.getElementById('tbmail-assistant-view')?.remove();
      doc.getElementById('tbmail-assistant-nav')?.remove();
      doc.defaultView.windowUtils.removeSheetUsingURIString(sheet,Ci.nsIDOMWindowUtils.USER_SHEET);
    }
  }
};
