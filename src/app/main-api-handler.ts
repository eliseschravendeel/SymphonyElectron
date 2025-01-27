import {
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  shell,
  systemPreferences,
} from 'electron';
import fetch from 'electron-fetch';
import {
  apiCmds,
  apiName,
  IApiArgs,
  IAuthResponse,
  INotificationData,
} from '../common/api-interface';
import { i18n, LocaleType } from '../common/i18n';
import { logger } from '../common/logger';
import { whitelistHandler } from '../common/whitelist-handler';
import { activityDetection } from './activity-detection';
import { analytics } from './analytics-handler';
import appStateHandler from './app-state-handler';
import { closeC9Pipe, connectC9Pipe, writeC9Pipe } from './c9-pipe-handler';
import { loadC9Shell, terminateC9Shell } from './c9-shell-handler';
import { getCitrixMediaRedirectionStatus } from './citrix-handler';
import { CloudConfigDataTypes, config, ICloudConfig } from './config-handler';
import { downloadHandler } from './download-handler';
import { getContentWindowHandle } from './hwnd-handler';
import { mainEvents } from './main-event-handler';
import { memoryMonitor } from './memory-monitor';
import notificationHelper from './notifications/notification-helper';
import { protocolHandler } from './protocol-handler';
import { finalizeLogExports, registerLogRetriever } from './reports-handler';
import { screenSnippet } from './screen-snippet-handler';
import { activate, handleKeyPress } from './window-actions';
import { ICustomBrowserWindow, windowHandler } from './window-handler';
import {
  downloadManagerAction,
  getWindowByName,
  isValidView,
  isValidWindow,
  sanitize,
  setDataUrl,
  showBadgeCount,
  showPopupMenu,
  updateFeaturesForCloudConfig,
  updateLocale,
  windowExists,
} from './window-utils';

import { getCommandLineArgs } from '../common/utils';
import { autoUpdate, AutoUpdateTrigger } from './auto-update-handler';
import { presenceStatus } from './presence-status-handler';
import { presenceStatusStore } from './stores/index';

// Swift search API
let swiftSearchInstance;
try {
  // tslint:disable-next-line:no-var-requires
  const { SSAPIBridge } = {} as any; // require('swift-search');
  swiftSearchInstance = new SSAPIBridge();
} catch (e) {
  console.warn(
    "Failed to initialize swift search. You'll need to include the search dependency. Contact the developers for more details",
  );
}
const broadcastMessage = (method, data) => {
  mainEvents.publish(apiCmds.onSwiftSearchMessage, [method, data]);
};

const getBrowserLoginUrl = (pod: string) =>
  `${pod}/login/sso/initsso?RelayState=${pod}/client-bff/device-login/index.html?callbackScheme=symphony&action=login`;
const AUTH_STATUS_PATH = '/login/checkauth?type=user';
interface IProxyDetails {
  username: string;
  password: string;
  hostname: string;
  retries: number;
}
const proxyDetails: IProxyDetails = {
  username: '',
  password: '',
  hostname: '',
  retries: 0,
};

let loginUrl = '';
let formattedPodUrl = '';
let credentialsPromise;
const credentialsPromiseRefHolder: { [key: string]: any } = {};

/**
 * Handle API related ipc messages from renderers. Only messages from windows
 * we have created are allowed.
 * Used mainly for Mana to communicate with SDA
 */
ipcMain.on(
  apiName.symphonyApi,
  async (event: Electron.IpcMainEvent, arg: IApiArgs) => {
    if (
      !(
        isValidWindow(BrowserWindow.fromWebContents(event.sender)) ||
        isValidView(event.sender)
      )
    ) {
      logger.error(
        `main-api-handler: invalid window try to perform action, ignoring action`,
        arg.cmd,
      );
      return;
    }

    if (!arg) {
      logger.error(
        'main-api-handler: no args received. Unable to handle API call.',
      );
      return;
    }
    const mainWebContents = windowHandler.getMainWebContents();
    logApiCallParams(arg);
    switch (arg.cmd) {
      case apiCmds.isOnline:
        if (typeof arg.isOnline === 'boolean') {
          windowHandler.isOnline = arg.isOnline;
        }
        break;
      case apiCmds.setBadgeCount:
        if (typeof arg.count === 'number') {
          showBadgeCount(arg.count);
          presenceStatusStore.setNotificationCount(arg.count);
          logger.info(`main-api-handler: show and update count: ${arg.count}`);
        }
        break;
      case apiCmds.registerProtocolHandler:
        protocolHandler.setPreloadWebContents(event.sender);
        // Since we register the prococol handler window upon login,
        // we make use of it and update the pod version info on SDA
        windowHandler.updateVersionInfo();

        // Set this to false once the SFE is completely loaded
        // so, we can prevent from showing error banners
        windowHandler.isWebPageLoading = false;
        windowHandler.isLoggedIn = true;
        break;
      case apiCmds.registerLogRetriever:
        registerLogRetriever(event.sender, arg.logName);
        break;
      case apiCmds.sendLogs:
        finalizeLogExports(arg.logs);
        break;
      case apiCmds.badgeDataUrl:
        if (typeof arg.dataUrl === 'string') {
          if (typeof arg.count === 'number' && arg.count > 0) {
            setDataUrl(arg.dataUrl, arg.count);
            logger.info(`main-api-handler: set badge count: ${arg.count}`);
          }
        }
        break;
      case apiCmds.activate:
        if (typeof arg.windowName === 'string') {
          activate(arg.windowName);
        }
        break;
      case apiCmds.registerLogger:
        // renderer window that has a registered logger from JS.
        logger.setLoggerWindow(event.sender);
        break;
      case apiCmds.registerActivityDetection:
        if (typeof arg.period === 'number') {
          // renderer window that has a registered activity detection from JS.
          activityDetection.setWindowAndThreshold(event.sender, arg.period);
        }
        break;
      case apiCmds.registerDownloadHandler:
        downloadHandler.setWindow(event.sender);
        break;
      case apiCmds.showNotificationSettings:
        if (typeof arg.windowName === 'string') {
          const theme = arg.theme ? arg.theme : 'light';
          windowHandler.createNotificationSettingsWindow(arg.windowName, theme);
        }
        break;
      case apiCmds.sanitize:
        if (typeof arg.windowName === 'string') {
          sanitize(arg.windowName);
        }
        windowHandler.isWebPageLoading = true;
        break;
      case apiCmds.bringToFront:
        // validates the user bring to front config and activates the wrapper
        if (typeof arg.reason === 'string' && arg.reason === 'notification') {
          const { bringToFront } = config.getConfigFields(['bringToFront']);
          if (bringToFront === CloudConfigDataTypes.ENABLED) {
            activate(arg.windowName, false);
          }
        }
        break;
      case apiCmds.openScreenPickerWindow:
        if (Array.isArray(arg.sources) && typeof arg.id === 'number') {
          windowHandler.createScreenPickerWindow(
            event.sender,
            arg.sources,
            arg.id,
          );
        }
        break;
      case apiCmds.popupMenu: {
        const browserWin = BrowserWindow.fromWebContents(
          event.sender,
        ) as ICustomBrowserWindow;
        if (
          browserWin &&
          windowExists(browserWin) &&
          (browserWin.winName === apiName.mainWindowName ||
            browserWin.winName === apiName.welcomeScreenName)
        ) {
          showPopupMenu({ window: browserWin });
          // Give focus back to main webContents so that
          // cut, copy & paste from edit menu works as expected
          if (mainWebContents && !mainWebContents.isDestroyed()) {
            mainWebContents.focus();
          }
        }
        break;
      }
      case apiCmds.setLocale:
        if (typeof arg.locale === 'string') {
          updateLocale(arg.locale as LocaleType);
        }
        break;
      case apiCmds.keyPress:
        if (typeof arg.keyCode === 'number') {
          handleKeyPress(arg.keyCode);
        }
        break;
      case apiCmds.getMyPresence:
        presenceStatus.setMyPresence(arg.status);
        logger.info('main-api-handler: get presence from C2 to set in SDA');
        break;
      case apiCmds.openScreenSnippet:
        screenSnippet.capture(event.sender, arg.hideOnCapture);
        break;
      case apiCmds.closeScreenSnippet:
        screenSnippet.cancelCapture();
        break;
      case apiCmds.closeWindow:
        windowHandler.closeWindow(arg.windowType, arg.winKey);
        break;
      case apiCmds.openScreenSharingIndicator:
        const { displayId, id, streamId } = arg;
        if (typeof displayId === 'string' && typeof id === 'number') {
          windowHandler.createScreenSharingIndicatorWindow(
            event.sender,
            displayId,
            id,
            streamId,
          );
        }
        break;
      case apiCmds.downloadManagerAction:
        if (typeof arg.path === 'string') {
          downloadManagerAction(arg.type, arg.path);
        }
        break;
      case apiCmds.openDownloadedItem:
        if (typeof arg.id === 'string') {
          downloadHandler.openFile(arg.id);
        }
        break;
      case apiCmds.showDownloadedItem:
        if (typeof arg.id === 'string') {
          downloadHandler.showInFinder(arg.id);
        }
        break;
      case apiCmds.clearDownloadedItems:
        downloadHandler.clearDownloadedItems();
        break;
      case apiCmds.restartApp:
        appStateHandler.restart();
        break;
      case apiCmds.setIsInMeeting:
        if (typeof arg.isInMeeting === 'boolean') {
          memoryMonitor.setMeetingStatus(arg.isInMeeting);
          appStateHandler.preventDisplaySleep(arg.isInMeeting);
          if (!arg.isInMeeting) {
            windowHandler.closeScreenPickerWindow();
            windowHandler.closeScreenSharingIndicator();
          }
        }
        break;
      case apiCmds.memoryInfo:
        if (typeof arg.memoryInfo === 'object') {
          memoryMonitor.setMemoryInfo(arg.memoryInfo);
        }
        break;
      case apiCmds.getConfigUrl:
        const { url } = config.getGlobalConfigFields(['url']);
        event.returnValue = url;
        break;
      case apiCmds.registerAnalyticsHandler:
        analytics.registerPreloadWindow(event.sender);
        break;
      case apiCmds.setCloudConfig:
        await updateFeaturesForCloudConfig(arg.cloudConfig as ICloudConfig);
        if (windowHandler.appMenu) {
          windowHandler.appMenu.buildMenu();
        }
        break;
      case apiCmds.setIsMana:
        if (typeof arg.isMana === 'boolean') {
          windowHandler.isMana = arg.isMana;
          // Update App Menu
          const appMenu = windowHandler.appMenu;
          const mainWindow = windowHandler.getMainWindow();
          if (mainWebContents) {
            const items = presenceStatus.createThumbarButtons();
            presenceStatus.updateSystemTrayPresence();
            mainWindow?.setThumbarButtons(items);
            logger.info('main-api-handler: Add actions preview menu');
          }

          if (appMenu && windowHandler.isMana) {
            appMenu.buildMenu();
          }
          logger.info('main-api-handler: isMana: ' + windowHandler.isMana);
        }
        break;
      case apiCmds.showNotification:
        if (typeof arg.notificationOpts === 'object') {
          const opts = arg.notificationOpts as INotificationData;
          notificationHelper.showNotification(opts);
        }
        break;
      case apiCmds.closeNotification:
        if (typeof arg.notificationId === 'number') {
          await notificationHelper.closeNotification(arg.notificationId);
        }
        break;
      /**
       * This gets called from mana, when user logs out
       */
      case apiCmds.closeAllWrapperWindows:
        windowHandler.closeAllWindows();
        const main = windowHandler.getMainWindow();
        terminateC9Shell();

        main?.setThumbarButtons([]);
        presenceStatus.onSignOut();
        break;
      case apiCmds.setZoomLevel:
        if (typeof arg.zoomLevel === 'number') {
          const mainWebContents = windowHandler.getMainWebContents();
          if (mainWebContents && !mainWebContents.isDestroyed()) {
            mainWebContents.setZoomFactor(arg.zoomLevel as number);
          }
        }
        break;
      case apiCmds.aboutAppClipBoardData:
        if (arg.clipboard && arg.clipboardType) {
          clipboard.write(
            { text: JSON.stringify(arg.clipboard, null, 4) },
            arg.clipboardType,
          );
        }
        break;
      case apiCmds.closeMainWindow:
        // Give focus back to main webContents
        if (mainWebContents && !mainWebContents.isDestroyed()) {
          mainWebContents.focus();
        }
        windowHandler.getMainWindow()?.close();
        break;
      case apiCmds.minimizeMainWindow:
        // Give focus back to main webContents
        if (mainWebContents && !mainWebContents.isDestroyed()) {
          mainWebContents.focus();
        }
        windowHandler.getMainWindow()?.minimize();
        break;
      case apiCmds.maximizeMainWindow:
        windowHandler.getMainWindow()?.maximize();
        // Give focus back to main webContents
        if (mainWebContents && !mainWebContents.isDestroyed()) {
          mainWebContents.focus();
        }
        break;
      case apiCmds.unmaximizeMainWindow:
        const mainWindow =
          windowHandler.getMainWindow() as ICustomBrowserWindow;
        if (mainWindow && windowExists(mainWindow)) {
          if (mainWindow.isFullScreen()) {
            mainWindow.setFullScreen(false);
          } else {
            mainWindow.unmaximize();
            setTimeout(() => {
              windowHandler.forceUnmaximize();
            }, 100);
          }
        }
        // Give focus back to main webContents
        if (mainWebContents && !mainWebContents.isDestroyed()) {
          mainWebContents.focus();
        }
        break;
      case apiCmds.browserLogin:
        await config.updateUserConfig({
          browserLoginAutoConnect: arg.browserLoginAutoConnect,
        });
        if (!arg.isPodConfigured) {
          await config.updateUserConfig({
            url: arg.newPodUrl,
          });
        }
        const urlFromCmd = getCommandLineArgs(process.argv, '--url=', false);
        const { url: userConfigURL } = config.getUserConfigFields(['url']);
        const { url: globalConfigURL } = config.getGlobalConfigFields(['url']);
        const podUrl = urlFromCmd
          ? urlFromCmd.substr(6)
          : userConfigURL
          ? userConfigURL
          : globalConfigURL;
        const { subdomain, domain, tld } = whitelistHandler.parseDomain(podUrl);
        formattedPodUrl = `https://${subdomain}.${domain}${tld}`;
        loginUrl = getBrowserLoginUrl(formattedPodUrl);
        logger.info(
          'main-api-handler:',
          'check if sso is enabled for the pod',
          formattedPodUrl,
        );
        loadPodUrl();
        break;
      case apiCmds.setBroadcastMessage:
        if (swiftSearchInstance) {
          mainEvents.subscribe(apiCmds.onSwiftSearchMessage, event.sender);
          swiftSearchInstance.setBroadcastMessage(broadcastMessage as any);
        }
        break;
      case apiCmds.handleSwiftSearchMessageEvents:
        if (swiftSearchInstance) {
          swiftSearchInstance.handleMessageEvents(arg.swiftSearchData);
        }
        break;
      case apiCmds.connectCloud9Pipe:
        connectC9Pipe(event.sender, arg.pipe);
        break;
      case apiCmds.writeCloud9Pipe:
        writeC9Pipe(arg.data);
        break;
      case apiCmds.closeCloud9Pipe:
        closeC9Pipe();
        break;
      case apiCmds.launchCloud9:
        await loadC9Shell(event.sender);
        break;
      case apiCmds.terminateCloud9:
        terminateC9Shell();
        break;
      case apiCmds.updateAndRestart:
        autoUpdate.updateAndRestart();
        break;
      case apiCmds.downloadUpdate:
        autoUpdate.downloadUpdate();
        break;
      case apiCmds.checkForUpdates:
        const autoUpdateTrigger = arg.autoUpdateTrigger;
        if (autoUpdateTrigger && autoUpdateTrigger in AutoUpdateTrigger) {
          autoUpdate.checkUpdates(arg.autoUpdateTrigger);
        } else {
          autoUpdate.checkUpdates();
        }
        break;
      default:
        break;
    }
  },
);

ipcMain.handle(
  apiName.symphonyApi,
  async (event: Electron.IpcMainInvokeEvent, arg: IApiArgs) => {
    if (
      !(
        isValidWindow(BrowserWindow.fromWebContents(event.sender)) ||
        isValidView(event.sender)
      )
    ) {
      logger.error(
        `main-api-handler: invalid window try to perform action, ignoring action`,
        arg.cmd,
      );
      return;
    }

    if (!arg) {
      return;
    }

    switch (arg.cmd) {
      case apiCmds.getCurrentOriginUrl:
        return windowHandler.getMainWindow()?.origin;
      case apiCmds.isAeroGlassEnabled:
        return systemPreferences.isAeroGlassEnabled();
      case apiCmds.showScreenSharePermissionDialog: {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow && !focusedWindow.isDestroyed()) {
          await dialog.showMessageBox(focusedWindow, {
            message: `${i18n.t(
              'Your administrator has disabled sharing your screen. Please contact your admin for help',
              'Permissions',
            )()}`,
            title: `${i18n.t('Permission Denied')()}!`,
            type: 'error',
          });
          return;
        }
        return;
      }
      case apiCmds.getMediaAccessStatus:
        const camera = systemPreferences.getMediaAccessStatus('camera');
        const microphone = systemPreferences.getMediaAccessStatus('microphone');
        const screen = systemPreferences.getMediaAccessStatus('screen');
        return {
          camera,
          microphone,
          screen,
        };
      case apiCmds.getSources:
        const { types, thumbnailSize } = arg;
        return desktopCapturer.getSources({
          types,
          thumbnailSize,
        });
      case apiCmds.getNativeWindowHandle:
        const browserWin = getWindowByName(arg.windowName);
        if (browserWin && windowExists(browserWin)) {
          const windowHandle = browserWin.getNativeWindowHandle();
          return getContentWindowHandle(windowHandle);
        }
        break;
      case apiCmds.getCitrixMediaRedirectionStatus:
        return getCitrixMediaRedirectionStatus();
      default:
        break;
    }
    return;
  },
);

/**
 * Log API call parameters.
 */
const logApiCallParams = (arg: any) => {
  const apiCmd = arg.cmd;
  switch (apiCmd) {
    case apiCmds.showNotification:
      const title = 'hidden';
      const body = 'hidden';
      const data = 'hidden';
      const notificationDetails: INotificationData = {
        ...arg.notificationOpts,
        title,
        body,
        data,
      };
      logger.info(
        `main-api-handler: - ${apiCmd} - Properties: ${JSON.stringify(
          notificationDetails,
          null,
          2,
        )}`,
      );
      break;
    case apiCmds.badgeDataUrl:
      const dataUrl = 'hidden';
      const badgeDataUrlDetails = {
        ...arg,
        dataUrl,
      };
      logger.info(
        `main-api-handler: - ${apiCmd} - Properties: ${JSON.stringify(
          badgeDataUrlDetails,
          null,
          2,
        )}`,
      );
      break;
    case apiCmds.openScreenPickerWindow:
      const sources = arg.sources.map((source: any) => {
        return {
          name: source.name,
          id: source.id,
          thumbnail: 'hidden',
          display_id: source.display_id,
          appIcon: source.appIcon,
        };
      });
      const openScreenPickerDetails = {
        ...arg,
        sources,
      };
      logger.info(
        `main-api-handler: - ${apiCmd} - Properties: ${JSON.stringify(
          openScreenPickerDetails,
          null,
          2,
        )}`,
      );
      break;
    case apiCmds.sendLogs:
      const logFiles = 'hidden';
      const logDetails = {
        ...arg.logs,
        logFiles,
      };
      logger.info(
        `main-api-handler: - ${apiCmd} - Properties: ${JSON.stringify(
          logDetails,
          null,
          2,
        )}`,
      );
      break;
    case apiCmds.writeCloud9Pipe:
      const compressedData = {
        ...arg,
        data: Buffer.from(arg.data).toString('base64'),
      };
      logger.info(
        `main-api-handler: - ${apiCmd} - Properties: ${JSON.stringify(
          compressedData,
          null,
          2,
        )}`,
      );
      break;
    default:
      logger.info(
        `main-api-handler: - ${apiCmd} - Properties: ${JSON.stringify(
          arg,
          null,
          2,
        )}`,
      );
      break;
  }
};

const loadPodUrl = (proxyLogin = false) => {
  logger.info('loading pod URL. Proxy: ', proxyLogin);
  let onLogin = {};
  if (proxyLogin) {
    onLogin = {
      async onLogin(authInfo) {
        // this 'authInfo' is the one received by the 'login' event. See https://www.electronjs.org/docs/latest/api/client-request#event-login
        proxyDetails.hostname = authInfo.host || authInfo.realm;
        await credentialsPromise;
        return Promise.resolve({
          username: proxyDetails.username,
          password: proxyDetails.password,
        });
      },
    };
  }
  fetch(`${formattedPodUrl}${AUTH_STATUS_PATH}`, onLogin)
    .then(async (response) => {
      const authResponse = (await response.json()) as IAuthResponse;
      logger.info('main-api-handler:', 'check auth response', authResponse);
      if (authResponse.authenticationType === 'sso') {
        logger.info(
          'main-api-handler:',
          'browser login is enabled - logging in',
          loginUrl,
        );
        await shell.openExternal(loginUrl);
      } else {
        logger.info(
          'main-api-handler:',
          'browser login is not enabled - loading main window with',
          formattedPodUrl,
        );
        const mainWebContents = windowHandler.getMainWebContents();
        if (mainWebContents && !mainWebContents.isDestroyed()) {
          windowHandler.setMainWindowOrigin(formattedPodUrl);
          mainWebContents.loadURL(formattedPodUrl);
        }
      }
    })
    .catch(async (error) => {
      if (
        (error.type === 'proxy' && error.code === 'PROXY_AUTH_FAILED') ||
        (error.code === 'ERR_TOO_MANY_RETRIES' && proxyLogin)
      ) {
        credentialsPromise = new Promise((res, _rej) => {
          credentialsPromiseRefHolder.resolutionCallback = res;
        });
        const welcomeWindow =
          windowHandler.getMainWindow() as ICustomBrowserWindow;
        windowHandler.createBasicAuthWindow(
          welcomeWindow,
          proxyDetails.hostname,
          proxyDetails.retries === 0,
          undefined,
          (username, password) => {
            proxyDetails.username = username;
            proxyDetails.password = password;
            credentialsPromiseRefHolder.resolutionCallback(true);
            loadPodUrl(true);
          },
        );
        proxyDetails.retries += 1;
      }
    });
};
