/* Local UI only: mail is archived exclusively following a user button click. */
var gmailRowArchive = class extends ExtensionAPI {
  getAPI() {
    return { gmailRowArchive: { start: async () => this.start() } };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.displays = new Map();
    this.windowListeners = new Map();
    this.action = GmailArchiveAction;
    const { MessageArchiver } = ChromeUtils.importESModule('resource:///modules/MessageArchiver.sys.mjs');
    this.archive = async header => {
      // Concurrent native archives are rejected before dispatch. Queue only that
      // explicit busy result; never retry an uncertain or partially applied move.
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          const archiver = new MessageArchiver();
          await new Promise((resolve, reject) => {
            archiver.oncomplete = resolve;
            Promise.resolve(archiver.archiveMessages([header])).catch(reject);
          });
          return;
        } catch (error) {
          if (String(error.message) !== 'Can only have one MessageArchiver running at once' || attempt === 24) throw error;
          await new Promise(resolve => this.timer.setTimeout(resolve, 200));
        }
      }
    };
    this.timer = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
    this.observeWindow = win => {
      if (this.windowListeners.has(win)) return;
      const onDocument = event => {
        const doc = event.target;
        if (doc?.documentURI === 'about:3pane') this.attachWhenReady(doc.defaultView);
      };
      win.addEventListener('DOMContentLoaded', onDocument, true);
      this.windowListeners.set(win, onDocument);
      for (const browser of win.document.querySelectorAll('browser')) {
        try {
          if (browser.contentDocument?.documentURI === 'about:3pane') this.attachWhenReady(browser.contentWindow);
        } catch {}
      }
    };
    this.wmListener = {
      onOpenWindow: outer => {
        const win = outer.docShell.domWindow;
        win.addEventListener('load', () => this.observeWindow(win), { once: true });
      },
      onCloseWindow: () => {},
    };
    Services.wm.addListener(this.wmListener);
    for (const win of Services.wm.getEnumerator('mail:3pane')) this.observeWindow(win);
  }

  attachWhenReady(pane, attempts = 0) {
    if (pane.closed || this.displays.has(pane.document)) return;
    if (!pane.threadTree || !pane.threadPane?.rowTemplate) {
      if (attempts < 40) this.timer.setTimeout(() => this.attachWhenReady(pane, attempts + 1), 200);
      return;
    }
    const doc = pane.document;
    const style = doc.createElement('style');
    style.id = 'gmail-row-archive-style';
    style.textContent = `
      #threadTree :is(#deleteCol, .deletecol-column) {
        box-sizing: border-box !important;
        inline-size: 76px !important; min-inline-size: 76px !important; max-inline-size: 76px !important;
      }
      #threadTree .deletecol-column { white-space: nowrap !important; }
      #threadTree .deletecol-column > .tree-button-delete,
      #threadTree .deletecol-column > .gmail-row-archive {
        display: inline-flex !important; vertical-align: middle !important;
        align-items: center; justify-content: center;
        inline-size: 28px; block-size: 26px; border: 0;
        padding: 4px !important; margin-inline: 1px !important;
        border-radius: 50%; background: transparent; color: #bec1c6; cursor: pointer;
      }
      #threadTree .gmail-row-archive:hover { background: #ffffff16; color: #fff; }
      #threadTree .gmail-row-archive {
        background-image: none !important; mask: none !important; content: normal !important;
        color: #a8c7fa !important; font: 600 22px/1 system-ui !important;
      }
      #threadTree .gmail-row-archive::before,
      #threadTree .gmail-row-archive::after { content: none !important; display: none !important; }
      #threadTree #deleteColButton { display: flex !important; align-items: center; justify-content: center; gap: 15px; }
      #threadTree .gmail-row-archive-heading { color: #a8c7fa; font: 600 20px/1 system-ui; pointer-events: none; }
      #threadTree .gmail-row-archive:focus-visible { outline: 2px solid #a8c7fa; }
      #threadTree tr[data-properties~="dummy"] .gmail-row-archive { visibility: hidden; }
      #threadTree tr[data-properties~="imapdeleted"] .tree-button-delete { display: none !important; }
    `;
    doc.head.appendChild(style);
    const ensureButtons = () => {
      const heading = doc.getElementById('deleteColButton');
      if (heading && !heading.querySelector('.gmail-row-archive-heading')) {
        const arrow = doc.createElement('span');
        arrow.className = 'gmail-row-archive-heading';
        arrow.textContent = '↓';
        arrow.setAttribute('aria-hidden', 'true');
        heading.appendChild(arrow);
        heading.title = 'Supprimer / Archiver';
      }
      const cells = [pane.threadPane.rowTemplate.content.querySelector('.deletecol-column'),
                     ...pane.threadTree.querySelectorAll('tbody tr.table-layout .deletecol-column')];
      for (const cell of cells) {
        if (!cell || cell.querySelector('.gmail-row-archive')) continue;
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'button-flat gmail-row-archive';
        button.title = 'Archiver';
        button.setAttribute('aria-label', 'Archiver ce message');
        button.tabIndex = -1;
        button.textContent = '↓';
        cell.appendChild(button);
      }
    };
    let pending = false;
    const observer = new pane.MutationObserver(() => {
      if (pending) return;
      pending = true;
      pane.requestAnimationFrame(() => { pending = false; ensureButtons(); });
    });
    observer.observe(pane.threadTree, { childList: true, subtree: true });
    const onClick = event => {
      // Thunderbird drops clicks with detail > 1, so rapid trash clicks were lost.
      // Treat each fast repeat as a fresh delete of the row now under the pointer.
      if (event.button === 0 && event.detail > 1 && event.target.classList?.contains('tree-button-request-delete')) {
        const row = event.target.closest('tr');
        if (row && Number.isInteger(row.index)) {
          event.stopPropagation();
          event.preventDefault();
          pane.gDBView?.applyCommandToIndices(Ci.nsMsgViewCommandType.deleteMsg, [row.index]);
        }
        return;
      }
      if (!event.target.closest?.('.gmail-row-archive')) return;
      this.action.click(event, index => pane.gDBView?.getMsgHdrAt(index), this.archive)
        .catch(error => { console.error('Gmail row archive:', error); });
    };
    pane.threadTree.addEventListener('click', onClick, true);
    // A fast second click on a row button must not open the message.
    const onDblClick = event => {
      if (event.target.closest?.('.tree-button-request-delete, .gmail-row-archive')) { event.stopPropagation(); event.preventDefault(); }
    };
    pane.threadTree.addEventListener('dblclick', onDblClick, true);
    ensureButtons();
    this.displays.set(doc, { pane, observer, onClick, onDblClick, style });
    pane.addEventListener('unload', () => {
      observer.disconnect();
      this.displays.delete(doc);
    }, { once: true });
  }

  onShutdown() {
    if (!this.started) return;
    if (this.wmListener) Services.wm.removeListener(this.wmListener);
    for (const [win, listener] of this.windowListeners) {
      try { win.removeEventListener('DOMContentLoaded', listener, true); } catch {}
    }
    for (const [doc, info] of this.displays) {
      info.observer.disconnect();
      info.pane.threadTree.removeEventListener('click', info.onClick, true);
      info.pane.threadTree.removeEventListener('dblclick', info.onDblClick, true);
      doc.querySelectorAll('.gmail-row-archive').forEach(button => button.remove());
      doc.querySelectorAll('.gmail-row-archive-heading').forEach(arrow => arrow.remove());
      info.pane.threadPane.rowTemplate.content.querySelectorAll('.gmail-row-archive').forEach(button => button.remove());
      info.style.remove();
    }
  }
};
