/**
 * Application menu and keyboard shortcuts.
 *
 * Gives Harbor the standard browser shortcuts (new/close tab, reload,
 * back/forward, focus address bar) plus the edit/clipboard roles the address
 * bar and pages need. Menu accelerators only fire while the app is focused,
 * unlike the duress globalShortcut which is intentionally system-wide.
 */
import { Menu, app, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  newTab: () => void;
  closeTab: () => void;
  reload: () => void;
  back: () => void;
  forward: () => void;
  focusAddress: () => void;
  toggleDevTools: () => void;
}

export function installAppMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: actions.newTab },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: actions.closeTab },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: isMac ? 'Cmd+Left' : 'Alt+Left', click: actions.back },
        { label: 'Forward', accelerator: isMac ? 'Cmd+Right' : 'Alt+Right', click: actions.forward },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: actions.reload },
        { type: 'separator' },
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: actions.focusAddress },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Toggle DevTools (page)', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: actions.toggleDevTools },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
