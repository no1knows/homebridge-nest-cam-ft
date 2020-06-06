let clientId = '';
let loginHint = '';
let cookies = '';
let apiKey = '';
let domain = '';

import puppeteer from 'puppeteer-extra';
import pluginStealth from 'puppeteer-extra-plugin-stealth';
puppeteer.use(pluginStealth());

puppeteer.launch({ headless: false }).then(async (browser: any) => {
  console.log('Opening chromium browser...');
  const page = await browser.newPage();
  const pages = await browser.pages();
  pages[0].close();
  await page.goto('https://home.nest.com', { waitUntil: 'networkidle2' });

  console.log('Please sign into your google account.');
  await page.setRequestInterception(true);
  page.on('request', async (request: any) => {
    const headers = request.headers();
    const url = request.url();
    // Getting cookies
    if (url.includes('CheckCookie')) {
      cookies = (await page.cookies())
        .map((cookie: any) => {
          return `${cookie.name}=${cookie.value}`;
        })
        .join('; ');
    }

    // Building issueToken
    if (url.includes('challenge?')) {
      const postData = request.postData().split('&');
      clientId = postData.find((query: string) => query.includes('client_id=')).slice(10);
    }

    // Getting apiKey
    if (url.includes('issue_jwt') && headers['x-goog-api-key']) {
      apiKey = headers['x-goog-api-key'];
      domain = encodeURIComponent(headers['referer'].slice(0, -1));
    }

    // Build googleAuth object
    if (apiKey && clientId && loginHint && cookies) {
      const auth = {
        issueToken: `https://accounts.google.com/o/oauth2/iframerpc?action=issueToken&response_type=token%20id_token&login_hint=${loginHint}&client_id=${clientId}&origin=${domain}&scope=openid%20profile%20email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fnest-account&ss_domain=${domain}`,
        cookies: cookies,
        apiKey: apiKey,
      };
      console.log('Add the following to your config.json:\n');
      console.log('"googleAuth": ', JSON.stringify(auth, null, 4));
      browser.close();
    }

    // Auth didn't work
    if (url.includes('cameras.get_owned_and_member_of_with_properties')) {
      console.log('Could not generate authentication object.');
      browser.close();
    }

    request.continue();
  });

  page.on('response', async (response: any) => {
    // Building issueToken
    if (response.url().includes('consent?')) {
      const headers = response.headers();
      const queries = headers.location.split('&');
      loginHint = queries.find((query: string) => query.includes('login_hint=')).slice(11);
    }
  });
});
