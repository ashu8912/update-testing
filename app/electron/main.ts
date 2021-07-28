import { Octokit } from '@octokit/core';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { app, BrowserWindow, ipcMain, Menu, MenuItem, screen } from 'electron';
import { IpcMainEvent, MenuItemConstructorOptions } from 'electron/main';
import log from 'electron-log';
import Store from 'electron-store';
import { i18n as I18n } from 'i18next';
import open from 'open';
import path from 'path';
import url from 'url';
import yargs from 'yargs';
import i18n from './i18next.config';

const appVersion = app.getVersion();
const store = new Store();
const args = yargs
  .option('headless', {
    describe: 'Open Headlamp in the default web browser instead of its app window',
  })
  .option('disable-gpu', {
    describe: 'Disable use of GPU. For people who may have buggy graphics drivers',
  })
  .parse();
const isHeadlessMode = args.headless;
const disableGPU = args['disable-gpu'];
const defaultPort = 4466;

function startServer(flags: string[] = []): ChildProcessWithoutNullStreams {
  const serverFilePath = path.join(process.resourcesPath, './server');

  const options = { shell: true, detached: false };
  if (process.platform !== 'win32') {
    // This makes the child processes a separate group, for easier killing.
    options.detached = true;
  }

  return spawn(serverFilePath, [...flags], options);
}

let serverProcess: ChildProcessWithoutNullStreams | null;
let intentionalQuit: boolean;
let serverProcessQuit: boolean;

function quitServerProcess() {
  if (!serverProcess || serverProcessQuit) {
    log.error('server process already not running');
    return;
  }

  intentionalQuit = true;
  log.info('stopping server process...');
  if (process.platform !== 'win32') {
    // Negative pid because it should kill the whole group of processes:
    //    https://azimi.me/2014/12/31/kill-child_process-node-js.html
    process.kill(-serverProcess.pid);
  }

  serverProcess.stdin.destroy();
  // @todo: should we try and end the process a bit more gracefully?
  //       What happens if the kill signal doesn't kill it?
  serverProcess.kill();

  serverProcess = null;
}

function setMenu(i18n: I18n) {
  const isMac = process.platform === 'darwin';

  const sep = { type: 'separator' };
  const aboutMenu = {
    label: i18n.t('About'),
    role: 'about',
  };
  const quitMenu = {
    label: i18n.t('Quit'),
    role: 'quit',
  };
  const selectAllMenu = {
    label: i18n.t('Select All'),
    role: 'selectAll',
  };
  const deleteMenu = {
    label: i18n.t('Delete'),
    role: 'delete',
  };

  const template = [
    // { role: 'appMenu' }
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              aboutMenu,
              sep,
              {
                label: i18n.t('Services'),
                role: 'services',
              },
              sep,
              {
                label: i18n.t('Hide Headlamp'),
                role: 'hide',
              },
              {
                label: i18n.t('Hide Others'),
                role: 'hideothers',
              },
              {
                label: i18n.t('Show All'),
                role: 'unhide',
              },
              sep,
              quitMenu,
            ],
          },
        ]
      : []),
    // { role: 'fileMenu' }
    {
      label: i18n.t('File'),
      submenu: [
        isMac
          ? {
              label: i18n.t('Close'),
              role: 'close',
            }
          : quitMenu,
      ],
    },
    // { role: 'editMenu' }
    {
      label: i18n.t('Edit'),
      submenu: [
        {
          label: i18n.t('Cut'),
          role: 'cut',
        },
        {
          label: i18n.t('Copy'),
          role: 'copy',
        },
        {
          label: i18n.t('Paste'),
          role: 'paste',
        },
        ...(isMac
          ? [
              {
                label: i18n.t('Paste and Match Style'),
                role: 'pasteAndMatchStyle',
              },
              deleteMenu,
              selectAllMenu,
              sep,
              {
                label: i18n.t('Speech'),
                submenu: [
                  {
                    label: i18n.t('Start Speaking'),
                    role: 'startspeaking',
                  },
                  {
                    label: i18n.t('Stop Speaking'),
                    role: 'stopspeaking',
                  },
                ],
              },
            ]
          : [deleteMenu, sep, selectAllMenu]),
      ],
    },
    // { role: 'viewMenu' }
    {
      label: i18n.t('View'),
      submenu: [
        {
          label: i18n.t('Reload'),
          role: 'forcereload',
        },
        {
          label: i18n.t('Toggle Developer Tools'),
          role: 'toggledevtools',
        },
        sep,
        {
          label: i18n.t('Reset Zoom'),
          role: 'resetzoom',
        },
        {
          label: i18n.t('Zoom In'),
          role: 'zoomin',
        },
        {
          label: i18n.t('Zoom Out'),
          role: 'zoomout',
        },
        sep,
        {
          label: i18n.t('Toogle Fullscreen'),
          role: 'togglefullscreen',
        },
      ],
    },
    {
      label: i18n.t('Window'),
      submenu: [
        {
          label: i18n.t('Minimize'),
          role: 'minimize',
        },
        ...(isMac
          ? [
              sep,
              {
                label: i18n.t('Bring All to Front'),
                role: 'front',
              },
              sep,
              {
                label: i18n.t('Window'),
                role: 'window',
              },
            ]
          : [
              {
                label: i18n.t('Close'),
                role: 'close',
              },
            ]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: i18n.t('Documentation'),
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://kinvolk.io/docs/headlamp/latest');
          },
        },
        {
          label: i18n.t('Open an Issue'),
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/kinvolk/headlamp/issues');
          },
        },
        {
          label: i18n.t('About'),
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/kinvolk/headlamp');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template as (MenuItemConstructorOptions | MenuItem)[]);
  Menu.setApplicationMenu(menu);
}

function startElecron() {
  log.transports.file.level = 'info';
  log.info('App starting...');

  let mainWindow: BrowserWindow | null;

  const isDev = process.env.ELECTRON_DEV || false;

  setMenu(i18n);

  function createWindow() {
    const startUrl =
      process.env.ELECTRON_START_URL ||
      url.format({
        pathname: path.join(process.resourcesPath, 'frontend', 'index.html'),
        protocol: 'file:',
        slashes: true,
      });
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow = new BrowserWindow({
      width,
      height,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: `${__dirname}/preload.js`,
      },
    });
    mainWindow.loadURL(startUrl);

    mainWindow.webContents.on('dom-ready', () => {
      const octokit = new Octokit();

      async function fetchRelease() {
        let githubReleaseURL = `GET /repos/{owner}/{repo}/releases/latest`;
        const response = await octokit.request(githubReleaseURL, {
          owner: 'ashu8912',
          repo: 'update-testing',
        });
        if (response.data.name !== appVersion) {
          mainWindow.webContents.send('update_available', {
            downloadURL: response.data.html_url,
          });
        }
        /*
  check if there is already a version in store if it exists don't store the current version
  this check will help us later in determining whether we are on the latest release or not
  */
        const storedAppVersion = store.get('app_version');
        console.log(storedAppVersion)
        if (!storedAppVersion) {
          store.set('app_version', appVersion);
        } else if (storedAppVersion !== appVersion) {
          // get the release notes for the version with which the app was built with
          let githubReleaseURL = `GET /repos/{owner}/{repo}/releases/tags/v${appVersion}`;
          let releaseTagResponse = await octokit.request(githubReleaseURL, {
            owner: 'ashu8912',
            repo: 'update-testing'
          });
          mainWindow.webContents.send('show_release_notes', { releaseNotes: releaseTagResponse.data.body });
          // set the store version to latest so that we don't show release notes on
          // every start of app
          store.set('app_version',appVersion);
        }
      }
      fetchRelease();
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    i18n.on('languageChanged', () => {
      setMenu(i18n);
    });

    ipcMain.on('locale', (event: IpcMainEvent, newLocale: string) => {
      if (!!newLocale && i18n.language !== newLocale) {
        i18n.changeLanguage(newLocale);
      }
    });

    if (!isDev) {
      serverProcess = startServer();
      attachServerEventHandlers(serverProcess);
    }
  }

  if (disableGPU) {
    log.info('Disabling GPU hardware acceleration.');
    app.disableHardwareAcceleration();
  }

  app.on('ready', createWindow);
  app.on('activate', function () {
    if (mainWindow === null) {
      createWindow();
    }
  });

  app.once('window-all-closed', app.quit);

  app.once('before-quit', () => {
    i18n.off('languageChanged');
    if (mainWindow) {
      mainWindow.removeAllListeners('close');
    }
  });
}

app.on('quit', quitServerProcess);

/**
 * add some error handlers to the serverProcess.
 * @param  {ChildProcess} serverProcess to attach the error handlers to.
 */
function attachServerEventHandlers(serverProcess: ChildProcessWithoutNullStreams) {
  serverProcess.on('error', err => {
    log.error(`server process failed to start: ${err}`);
  });
  serverProcess.stdout.on('data', data => {
    log.info(`server process stdout: ${data}`);
  });
  serverProcess.stderr.on('data', data => {
    const sterrMessage = `server process stderr: ${data}`;
    if (data && data.indexOf && data.indexOf('Requesting') !== -1) {
      // The server prints out urls it's getting, which aren't errors.
      log.info(sterrMessage);
    } else {
      log.error(sterrMessage);
    }
  });
  serverProcess.on('close', (code, signal) => {
    const closeMessage = `server process process exited with code:${code} signal:${signal}`;
    if (!intentionalQuit) {
      // @todo: message mainWindow, or loadURL to an error url?
      log.error(closeMessage);
    } else {
      log.info(closeMessage);
    }
    serverProcessQuit = true;
  });
}

if (isHeadlessMode) {
  serverProcess = startServer(['-html-static-dir', path.join(process.resourcesPath, './frontend')]);
  attachServerEventHandlers(serverProcess);
  (async () => {
    await open(`http://localhost:${defaultPort}`);
  })();
} else {
  startElecron();
}
