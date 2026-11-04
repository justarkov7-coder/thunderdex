/* The same bounded action is used by the add-on and the isolated action tests. */
var GmailArchiveAction = {
  async click(event, resolveHeader, archiveHeader) {
    if (event.button !== undefined && event.button !== 0) return false;
    const button = event.target.closest?.('.gmail-row-archive');
    if (!button || button.disabled) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const row = button.closest('tr');
    if (!row || !Number.isInteger(row.index) || row.index < 0 ||
        (row.dataset.properties || '').split(' ').includes('dummy')) return false;
    const header = resolveHeader(row.index);
    if (!header?.folder) return false;
    button.disabled = true;
    try {
      await archiveHeader(header);
      return true;
    } finally {
      button.disabled = false;
    }
  }
};
if (typeof module !== 'undefined') module.exports = GmailArchiveAction;
