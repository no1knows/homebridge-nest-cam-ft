/* eslint-disable no-await-in-loop */
import Browser from 'puppeteer-core';
import puppeteer from 'puppeteer-extra';
import pluginStealth from 'puppeteer-extra-plugin-stealth';
import * as os from 'os';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { UiServer } from '../homebridge-ui/server';
import execa from 'execa';
import { generateToken, getRefreshToken } from '../nest/connection';

export async function getChromiumBrowser(): Promise<string> {
  const platform = os.platform();
  const binaryNames = ['chromium', 'chromium-browser', 'chrome', 'google-chrome'];
  const userDefinedChromiumPath = process.argv.includes('-p')
    ? process.argv[process.argv.indexOf('-p') + 1]
    : undefined;

  const whichChromiumBrowser = async (binary: string): Promise<string> => {
    try {
      const output = await execa('which', [binary]);
      return output.stdout;
    } catch (err) {
      return '';
    }
  };

  // user defined path overrides everything
  if (userDefinedChromiumPath) {
    return userDefinedChromiumPath;
  }

  // if we are on x64 then using the chromium provided by puppeteer is ok
  if (os.arch() === 'x64') {
    if (fs.existsSync(Browser.executablePath())) {
      return Browser.executablePath();
    }
  }

  // try and find an existing copy of chrome / chromium
  let possiblePaths: Array<string> = [];

  if (platform === 'linux' || platform === 'freebsd') {
    const searchPaths = [
      '/usr/local/sbin',
      '/usr/local/bin',
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin',
      '/opt/google/chrome',
    ];

    for (const searchPath of searchPaths) {
      possiblePaths = possiblePaths.concat(binaryNames.map((x) => path.join(searchPath, x)));
    }
  }

  if (platform === 'darwin') {
    possiblePaths = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }

  if (platform === 'win32') {
    possiblePaths = [
      path.join(process.env['ProgramFiles(x86)'] || '', '\\Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', '\\Google\\Application\\chrome.exe'),
    ];
  }

  const availableBinaries = possiblePaths.filter((x) => fs.existsSync(x));

  if (availableBinaries.length) {
    return availableBinaries[0];
  }

  // attempt to find binary with "which" command
  if (platform === 'linux' || platform === 'freebsd' || platform === 'darwin') {
    for (const bin of binaryNames) {
      const whichPath = await whichChromiumBrowser(bin);
      if (whichPath) {
        return whichPath;
      }
    }
  }

  return '';
}

export class AutoLogin {
  public browser: Browser.Browser | undefined;
  public running = false;

  async login(email?: string, password?: string, uix?: UiServer): Promise<void> {
    this.running = true;
    const executablePath = await getChromiumBrowser();

    if (!executablePath) {
      console.error('Cannot find Chromium or Google Chrome installed on your system.');

      setTimeout(() => {
        process.exit(1);
      }, 100);
    }

    puppeteer.use(pluginStealth());

    const headless = !process.argv.includes('-h');
    const ft = process.argv.includes('-ft');
    const token = generateToken(ft);
    const homeUrl = token.url;
    const code_verifier = token.code;

    const prompt = (key: 'username' | 'password' | 'totp', query: string, hidden = false): Promise<string> =>
      new Promise(async (resolve, reject) => {
        // handle uix prompts
        if (uix) {
          switch (key) {
            case 'username': {
              return resolve(await uix.getUsername());
            }
            case 'password': {
              return resolve(await uix.getPassword());
            }
            case 'totp': {
              return resolve(await uix.getTotp());
            }
            default: {
              return reject(Error(`Unhandled Prompt Key: ${key}`));
            }
          }
        }

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          if (hidden) {
            const stdin = process.openStdin();
            process.stdin.on('data', (char: string) => {
              char = char + '';
              switch (char) {
                case '\n':
                case '\r':
                case '\u0004':
                  stdin.pause();
                  break;
                default:
                  process.stdout.clearLine(0);
                  readline.cursorTo(process.stdout, 0);
                  process.stdout.write(query + Array(rl.line.length + 1).join('*'));
                  break;
              }
            });
          }
          rl.question(query, (value) => {
            resolve(value);
            rl.close();
          });
        } catch (err) {
          reject(err);
        }
      });

    const inputData = async function (
      identifier: string,
      alias: 'username' | 'password' | 'totp',
      message: string,
      value: string | undefined,
      page: Browser.Page,
    ): Promise<boolean> {
      try {
        await page.waitForSelector(identifier, { timeout: 5000 });
      } catch (error) {
        console.error(`Unable to find input field for ${alias}.`);
        if (uix) {
          uix.showError(`Unable to find input field for ${alias}.`);
        }
        return false;
      }
      let badInput = true;
      while (badInput) {
        if (!value) {
          value = (await prompt(alias, message, alias === 'password')) || '';
          if (!value) {
            return false;
          }
        }
        await page.type(identifier, value);
        await page.keyboard.press('Enter');
        try {
          await page.waitForSelector(`${identifier}[aria-invalid="true"]`, { timeout: 1000 });
        } catch (err) {
          badInput = false;
        }
        if (badInput) {
          value = undefined;
          console.error(`Incorrect ${alias}. Please try again.`);
          // Reset the invalid login
          await page.click(identifier, { clickCount: 3 });
        }
      }
      return true;
    };

    try {
      const options: Browser.LaunchOptions = { headless: headless };
      options.executablePath = executablePath;
      options.args = [];

      // need some extra flags if running as root
      if (os.userInfo().uid === 0) {
        options.args.push('--no-sandbox', '--disable-setuid-sandbox');
      }

      this.browser = await puppeteer.launch(options);
    } catch (err) {
      console.error(
        `Unable to open chromium browser at path: ${executablePath}. You may need to install chromium manually and try again.`,
      );
      if (uix) {
        uix.showError('Unable to open chromium.');
      }
      return;
    }

    try {
      if (uix) {
        uix.sendStartupSuccess();
      } else {
        console.log('Opening chromium browser...');
      }
      const page = await this.browser.newPage();
      const pages = await this.browser.pages();
      pages[0].close();
      // This stops google login from throwing untrusted browser error
      await page.evaluateOnNewDocument(() => {
        const newProto = Object.getPrototypeOf(navigator);
        delete newProto.webdriver;
        Object.setPrototypeOf(navigator, newProto);
      });
      await page.goto(homeUrl, { waitUntil: 'networkidle2' });
      page.on('response', async (response: Browser.Response) => {
        const url = response.url();
        const req = response.request();
        const orig = req.url();

        // Auth didn't work
        if (orig.includes('www.google.')) {
          if (uix) {
            uix.showError('Could not generate refresh token');
          } else {
            console.log('Could not generate refresh token');
          }
          this.stop();
        }

        // Getting code
        if (url.includes('approval?authuser=0')) {
          try {
            const text = unescape(await response.text());
            const query = text.split('?')[1].split('"')[0];
            const refreshToken = await getRefreshToken(query, code_verifier, ft);
            if (uix) {
              uix.setCredentials(refreshToken);
            } else {
              console.log(`"refreshToken": ${refreshToken}`);
            }
            this.stop();
          } catch (error) {
            console.error(`Invalid request url.`);
            if (uix) {
              uix.showError(`Invalid request url.`);
            }
          }
        }
      });

      if (headless) {
        if (!(await inputData('#identifierId', 'username', 'Email or phone: ', email, page))) {
          return;
        }
        await page.waitForTimeout(1000);
        if (!(await inputData('input[type="password"]', 'password', 'Password: ', password, page))) {
          return;
        }
        if (!uix) {
          console.log('Finishing up...');
        }

        try {
          await page.waitForSelector('input[name="totpPin"],input[name="idvPin"]', { timeout: 5000 });
          if (!uix) {
            console.log('2-step Verification Required');
          }

          if (
            !(await inputData(
              'input[name="totpPin"],input[name="idvPin"]',
              'totp',
              'Please enter the verification code from the Google Authenticator app or SMS: ',
              undefined,
              page,
            ))
          ) {
            return;
          }
        } catch (e) {
          // totp is not enabled
          try {
            await page.waitForSelector(
              'figure[data-illustration="authzenGmailApp"],figure[data-illustration="authzenHiddenPin"]',
              { timeout: 1000 },
            );
            // Check for extra protection
            try {
              await page.waitForSelector('div[data-form-action-uri] samp', { timeout: 1000 });
              const element = await page.$('div[data-form-action-uri] samp');
              const num = await page.evaluate((el) => el.textContent, element);
              if (uix) {
                uix.showNotice(`Open the Gmail app, tap Yes on the prompt to sign in, and select '${num}'.`);
              } else {
                console.log(`Open the Gmail app, tap Yes on the prompt to sign in, and select '${num}'.`);
              }
            } catch (err) {
              if (uix) {
                uix.showNotice('Open the Gmail app and tap Yes on the prompt to sign in.');
              } else {
                console.log('Open the Gmail app and tap Yes on the prompt to sign in.');
              }
            }
          } catch (error) {
            // Gmail 2FA is not enabled
            try {
              await page.waitForSelector('#assistiveActionOutOfQuota', { timeout: 1000 });
              if (uix) {
                uix.showError('Unavailable because of too many failed attempts. Try again in a few hours.');
              } else {
                console.error('Unavailable because of too many failed attempts. Try again in a few hours.');
              }
              this.stop();
              return;
            } catch (error) {
              // Login did not fail because of too many attempts
            }
          }
        }

        try {
          await page.waitForSelector('div[data-primary-action-label="Allow"] button', { timeout: 30000 });
          await page.click('div[data-primary-action-label="Allow"] button');
        } catch (error) {
          console.error(`Unable to find login button.`);
          if (uix) {
            uix.showError(`Unable to find login button.`);
          }
          this.stop();
        }
      }
    } catch (err) {
      console.error('Unable to retrieve credentials.');
      console.error(err);
      if (uix) {
        uix.showError('An error occured while trying to get load generate token.');
      }
      this.stop();
    }
  }

  stop(): void {
    try {
      this.running = false;
      this.browser?.close();
    } catch (e) {}
  }
}
