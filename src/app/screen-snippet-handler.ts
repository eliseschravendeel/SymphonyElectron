import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import sizeOf from 'image-size';
import * as os from 'os';
import * as path from 'path';

import { ChildProcess, ExecException, execFile } from 'child_process';
import * as util from 'util';
import { IScreenSnippet } from '../common/api-interface';
import {
  isDevEnv,
  isElectronQA,
  isLinux,
  isMac,
  isWindowsOS,
} from '../common/env';
import { i18n } from '../common/i18n';
import { logger } from '../common/logger';
import { updateAlwaysOnTop } from './window-actions';
import { windowHandler } from './window-handler';
import { windowExists } from './window-utils';

const readFile = util.promisify(fs.readFile);

class ScreenSnippet {
  private readonly tempDir: string;
  private readonly captureUtil: string;
  private outputFileName: string | undefined;
  private captureUtilArgs: ReadonlyArray<string> | undefined;
  private child: ChildProcess | undefined;
  private focusedWindow: BrowserWindow | null = null;
  private shouldUpdateAlwaysOnTop: boolean = false;

  constructor() {
    if (isElectronQA) {
      this.tempDir = os.tmpdir();
    } else {
      this.tempDir = path.join(app.getPath('userData'), 'temp');
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir);
      }
    }
    this.captureUtil = isMac
      ? '/usr/sbin/screencapture'
      : isDevEnv
        ? path.join(
          __dirname,
          '../../../node_modules/screen-snippet/ScreenSnippet.exe',
        )
        : path.join(path.dirname(app.getPath('exe')), 'ScreenSnippet.exe');

    if (isLinux) {
      this.captureUtil = '/usr/bin/gnome-screenshot';
    }
  }

  /**
   * Captures a user selected portion of the monitor and returns jpeg image
   * encoded in base64 format.
   *
   * @param webContents {Electron.webContents}
   */
  public async capture(webContents: Electron.webContents) {
    const mainWindow = windowHandler.getMainWindow();
    if (mainWindow && windowExists(mainWindow) && isWindowsOS) {
      this.shouldUpdateAlwaysOnTop = mainWindow.isAlwaysOnTop();
      if (this.shouldUpdateAlwaysOnTop) {
        await updateAlwaysOnTop(false, false, false);
      }
    }
    logger.info(`screen-snippet-handler: Starting screen capture!`);
    this.outputFileName = path.join(
      this.tempDir,
      'symphonyImage-' + Date.now() + '.png',
    );
    if (isMac) {
      this.captureUtilArgs = ['-i', '-s', '-t', 'png', this.outputFileName];
    } else if (isWindowsOS) {
      if (windowHandler.isMana) {
        this.captureUtilArgs = [
          '--no-annotate',
          this.outputFileName,
          i18n.getLocale(),
        ];
      } else {
        this.captureUtilArgs = [this.outputFileName, i18n.getLocale()];
      }
    } else if (isLinux) {
      this.captureUtilArgs = ['-a', '-f', this.outputFileName];
    } else {
      this.captureUtilArgs = [];
    }
    this.focusedWindow = BrowserWindow.getFocusedWindow();

    logger.info(
      `screen-snippet-handler: Capturing snippet with file ${this.outputFileName} and args ${this.captureUtilArgs}!`,
    );

    // only allow one screen capture at a time.
    if (this.child) {
      logger.info(
        `screen-snippet-handler: Child screen capture exists, killing it and keeping only 1 instance!`,
      );
      this.killChildProcess();
    }
    try {
      await this.execCmd(this.captureUtil, this.captureUtilArgs);
      if (windowHandler.isMana) {
        windowHandler.closeSnippingToolWindow();
        const dimensions = this.getImageSize();
        windowHandler.createSnippingToolWindow(this.outputFileName, dimensions);
        this.uploadSnippet(webContents);
        return;
      }
      const {
        message,
        data,
        type,
      }: IScreenSnippet = await this.convertFileToData();
      logger.info(
        `screen-snippet-handler: Snippet captured! Sending data to SFE`,
      );
      webContents.send('screen-snippet-data', { message, data, type });
      await this.verifyAndUpdateAlwaysOnTop();
    } catch (error) {
      await this.verifyAndUpdateAlwaysOnTop();
      logger.error(
        `screen-snippet-handler: screen capture failed with error: ${error}!`,
      );
    }
  }

  /**
   * Cancels a screen capture and closes the snippet window
   */
  public async cancelCapture() {
    if (!isWindowsOS) {
      return;
    }
    logger.info(`screen-snippet-handler: Cancel screen capture!`);
    this.focusedWindow = BrowserWindow.getFocusedWindow();

    try {
      await this.execCmd(this.captureUtil, []);
      await this.verifyAndUpdateAlwaysOnTop();
    } catch (error) {
      await this.verifyAndUpdateAlwaysOnTop();
      logger.error(
        `screen-snippet-handler: screen capture cancel failed with error: ${error}!`,
      );
    }
  }

  /**
   * Kills the child process when the application is reloaded
   */
  public killChildProcess(): void {
    if (this.child && typeof this.child.kill === 'function') {
      this.child.kill();
    }
  }

  /**
   * Executes the given command via a child process
   *
   * Windows: uses custom built windows screen capture tool
   * Mac OSX: uses built-in screencapture tool which has been
   * available since OSX ver 10.2.
   *
   * @param captureUtil {string}
   * @param captureUtilArgs {captureUtilArgs}
   * @example execCmd('-i -s', '/user/desktop/symphonyImage-1544025391698.png')
   */
  private execCmd(
    captureUtil: string,
    captureUtilArgs: ReadonlyArray<string>,
  ): Promise<ChildProcess> {
    logger.info(
      `screen-snippet-handlers: execCmd ${captureUtil} ${captureUtilArgs}`,
    );
    return new Promise<ChildProcess>((resolve, reject) => {
      return (this.child = execFile(
        captureUtil,
        captureUtilArgs,
        (error: ExecException | null) => {
          if (error && error.killed) {
            // processs was killed, just resolve with no data.
            return reject(error);
          }
          resolve();
        },
      ));
    });
  }

  /**
   * Converts the temporary stored file into base64
   * and removes the temp file
   *
   * @return Promise<IScreenSnippet> { message, data, type }
   */
  private async convertFileToData(): Promise<IScreenSnippet> {
    try {
      if (!this.outputFileName) {
        logger.info(
          `screen-snippet-handler: screen capture failed! output file doesn't exist!`,
        );
        return { message: 'output file name is required', type: 'ERROR' };
      }
      const data = await readFile(this.outputFileName);
      if (!data) {
        logger.info(
          `screen-snippet-handler: screen capture failed! data doesn't exist!`,
        );
        return { message: `no file data provided`, type: 'ERROR' };
      }
      // convert binary data to base64 encoded string
      const output = Buffer.from(data).toString('base64');
      return { message: 'success', data: output, type: 'image/png;base64' };
    } catch (error) {
      // no such file exists or user likely aborted
      // creating snippet. also include any error when
      // creating child process.
      return error && error.code === 'ENOENT'
        ? { message: `file does not exist`, type: 'ERROR' }
        : { message: `${error}`, type: 'ERROR' };
    } finally {
      if (this.focusedWindow && windowExists(this.focusedWindow)) {
        this.focusedWindow.moveTop();
      }
      // remove tmp file (async)
      if (this.outputFileName) {
        this.deleteFile(this.outputFileName);
      }
    }
  }

  /**
   * Deletes a locally stored file
   * @param filePath Path for the file to delete
   */
  private deleteFile(filePath: string) {
    fs.unlink(filePath, (removeErr) => {
      logger.info(
        `screen-snippet-handler: cleaning up temp snippet file: ${filePath}!`,
      );
      if (removeErr) {
        logger.error(
          `screen-snippet-handler: error removing temp snippet file: ${filePath}, err: ${removeErr}`,
        );
      }
    });
  }

  /**
   * Verify and updates always on top
   */
  private async verifyAndUpdateAlwaysOnTop(): Promise<void> {
    if (this.shouldUpdateAlwaysOnTop) {
      await updateAlwaysOnTop(true, false, false);
      this.shouldUpdateAlwaysOnTop = false;
    }
  }

  /**
   * Gets the height & width of an image
   */
  private getImageSize():
    | {
      height: number | undefined;
      width: number | undefined;
    }
    | undefined {
    if (!this.outputFileName) {
      return undefined;
    }

    const dimensions = sizeOf(this.outputFileName);
    return {
      height: dimensions.height,
      width: dimensions.width,
    };
  }

  /**
   * Uploads a screen snippet
   * @param webContents A browser window's web contents object
   */
  private uploadSnippet(webContents: Electron.webContents) {
    ipcMain.once('upload-snippet', async (_event, snippetData: { screenSnippetPath: string, mergedImageData: string }) => {
      try {
        windowHandler.closeSnippingToolWindow();
        const [type, data] = snippetData.mergedImageData.split(',');
        const payload = {
          message: 'SUCCESS',
          data,
          type,
        };
        logger.info(
          `screen-snippet-handler: Snippet captured! Sending data to SFE`,
        );
        webContents.send('screen-snippet-data', payload);
        await this.verifyAndUpdateAlwaysOnTop();
      } catch (error) {
        await this.verifyAndUpdateAlwaysOnTop();
        logger.error(
          `screen-snippet-handler: screen capture failed with error: ${error}!`,
        );
      } finally {
        this.deleteFile(snippetData.screenSnippetPath);
      }
    });
  }
}

const screenSnippet = new ScreenSnippet();

export { screenSnippet };
