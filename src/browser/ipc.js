// Renderer IPC: the ui:action dispatch table. Meta operations (window chrome,
// find bar, space management) are never gated by space control; tab mutations
// require the active space to be user-controlled.
export function setupIpc(ctx, ipcMain) {
  // ctx: { win, spaces(), activeWc(), findbar, zoomDefaultsNote }
  let findText = '';

  ipcMain.handle('ui:action', (_e, msg) => {
    const { type } = msg ?? {};
    const space = ctx.spaces().getActive();
    const userEditable = !!space && space.control === 'user';
    switch (type) {
      case 'back': if (userEditable) ctx.activeTabWc()?.navigationHistory.goBack(); break;
      case 'forward': if (userEditable) ctx.activeTabWc()?.navigationHistory.goForward(); break;
      case 'reload': if (userEditable) ctx.activeTabWc()?.reload(); break;
      case 'navigate':
        if (userEditable && typeof msg.url === 'string' && msg.url) {
          const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(msg.url) ? msg.url : `https://${msg.url}`;
          ctx.activeTabWc()?.loadURL(url).catch(() => {});
        }
        break;
      case 'newTab':
        if (userEditable) ctx.spaces().addUserTab(space.id, typeof msg.url === 'string' && msg.url ? msg.url : 'about:blank');
        break;
      case 'closeTab':
        if (userEditable && typeof msg.targetId === 'string') ctx.spaces().closeUserTab(space.id, msg.targetId);
        break;
      case 'moveTab':
        if (userEditable && typeof msg.targetId === 'string' && Number.isInteger(msg.toIndex)) {
          ctx.spaces().moveUserTab(space.id, msg.targetId, msg.toIndex);
        }
        break;
      case 'activateTab':
        if (userEditable && typeof msg.targetId === 'string') ctx.spaces().activateUserTab(space.id, msg.targetId);
        break;
      // Find bar: meta operation over the active tab, never gated.
      case 'findToggle': ctx.findbar.toggle(); break;
      case 'find':
        findText = typeof msg.text === 'string' ? msg.text : '';
        ctx.findbar.setText(findText);
        if (findText) ctx.activeTabWc()?.findInPage(findText);
        else ctx.activeTabWc()?.stopFindInPage('clearSelection');
        break;
      case 'findNext':
        if (findText) ctx.activeTabWc()?.findInPage(findText, { forward: msg.forward !== false, findNext: true });
        break;
      case 'findClose':
        ctx.activeTabWc()?.stopFindInPage('clearSelection');
        ctx.findbar.hide();
        break;
      case 'switchSpace':
        if (typeof msg.id === 'number' && ctx.spaces().getSpace(msg.id)) ctx.spaces().setActiveSpace(msg.id);
        break;
      // Sidebar space management: meta operations, never gated by the active
      // space's control state.
      case 'newSpace':
        ctx.spaces().createUserSpace(typeof msg.name === 'string' ? msg.name : '');
        break;
      case 'closeSpace':
        if (typeof msg.id === 'number') ctx.spaces().closeUserSpace(msg.id);
        break;
      case 'takeover': if (space) ctx.spaces().handOffTaskSpace({ id: space.id }); break;
      case 'handback': if (space) ctx.spaces().takeOverTaskSpace({ id: space.id }); break;
      // Window chrome: always the user's domain, never gated by space control.
      case 'winControl':
        if (msg.op === 'minimize') ctx.win.minimize();
        else if (msg.op === 'maximize') ctx.win.isMaximized() ? ctx.win.unmaximize() : ctx.win.maximize();
        else if (msg.op === 'close') ctx.win.close();
        break;
    }
    ctx.pushState();
  });
}
