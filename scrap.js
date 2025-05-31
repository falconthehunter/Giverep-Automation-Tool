import puppeteer from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

// --- Configurations ---
const chromiumPath = '/usr/bin/chromium';
const targetKeywords = [
  "Giverep",
  "giverep"
];
const outputFile = path.join(process.cwd(), 'tweets_to_reply.txt');
const authFilePath = path.join(process.cwd(), 'auth.json');
const proxy = process.env.HTTP_PROXY || '';
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
];
const maxTweetsPerKeyword = 100;

// --- Colorful Logging ---
const chalkStyles = [
  chalk.red, chalk.green, chalk.yellow, chalk.blue, chalk.magenta, chalk.cyan, chalk.white, chalk.gray
];
function randomChalk(msg) {
  return chalkStyles[Math.floor(Math.random() * chalkStyles.length)](msg);
}
function logAny(msg) {
  console.log(randomChalk(msg));
}
function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}
function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// --- Load auth ---
if (!fs.existsSync(authFilePath)) {
  logAny("Missing auth.json file!");
  process.exit(1);
}
const authData = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
if (!authData.auth_token || !authData.ct0) {
  logAny("auth.json must have both 'auth_token' and 'ct0'!");
  process.exit(1);
}
const twitterCookieData = [
  { name: 'ct0', value: authData.ct0, domain: '.x.com' },
  { name: 'auth_token', value: authData.auth_token, domain: '.x.com' }
];

// --- Puppeteer setup ---
puppeteerExtra.use(StealthPlugin());

async function initializeBrowser() {
  const launchArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080'
  ];
  if (proxy) {
    launchArgs.push(`--proxy-server=${proxy}`);
    logAny(`Using proxy: ${proxy}`);
  }
  const userAgent = getRandomUserAgent();
  logAny(`User-Agent: ${userAgent}`);
  logAny("Launching browser...");
  const browser = await puppeteerExtra.launch({
    headless: true,
    executablePath: chromiumPath,
    args: launchArgs
  });
  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  page.setDefaultNavigationTimeout(60000);

  logAny("Opening https://x.com/ for login...");
  await page.goto('https://x.com/', { waitUntil: 'domcontentloaded' });
  logAny("Setting Twitter auth cookies...");
  await page.setCookie(...twitterCookieData);
  logAny("Reloading page to apply authentication...");
  await page.reload({ waitUntil: 'domcontentloaded' });
  await delay(1000); // shorter delay
  logAny("Should be logged in now!");
  return { browser, page };
}

async function scrapeUrlsForKeyword(page, keyword) {
  const url = `https://x.com/search?q=${encodeURIComponent(keyword)}&src=spelling_expansion_revert_click`;
  logAny(`Navigating to search page for keyword: ${keyword}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    logAny('Error: ' + e);
    return [];
  }

  // Wait for tweets or timeout, whichever is first (max 8s)
  try {
    await Promise.race([
      page.waitForSelector('[data-testid="tweetText"]', { timeout: 8000 }),
      delay(8000),
    ]);
  } catch {}

  const tweetUrlSet = new Set();
  let lastHeight = await page.evaluate('document.body.scrollHeight');
  let scrollTries = 0;
  let maxScrollTries = 20;

  while (tweetUrlSet.size < maxTweetsPerKeyword && scrollTries < maxScrollTries) {
    // Only collect main tweet URLs (no /photo/, /analytics, etc)
    let urls = await page.$$eval('article a[href*="/status/"]', links =>
      Array.from(new Set(
        links
          .map(link => link.href)
          .filter(href =>
            /^https:\/\/x\.com\/[^\/]+\/status\/\d+$/.test(href)
          )
      ))
    );
    urls.forEach(url => tweetUrlSet.add(url));

    logAny(`Collected ${tweetUrlSet.size} unique tweets so far...`);

    // If collected enough, break early
    if (tweetUrlSet.size >= maxTweetsPerKeyword) break;

    // Scroll down and wait a bit for new tweets to load
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await delay(1200 + Math.random() * 600);

    let newHeight = await page.evaluate('document.body.scrollHeight');
    if (newHeight === lastHeight) {
      scrollTries++;
    } else {
      scrollTries = 0;
      lastHeight = newHeight;
    }
  }

  logAny(`Found ${tweetUrlSet.size} tweet URLs for keyword: ${keyword}`);
  if (tweetUrlSet.size === 0) {
    logAny(`No tweets found for "${keyword}". Screenshotting for debug...`);
    await page.screenshot({ path: `no_tweets_${keyword.replace(/[^a-z0-9]/gi, '_')}.png` });
  }

  return Array.from(tweetUrlSet).slice(0, maxTweetsPerKeyword);
}

const main = async () => {
  const { browser, page } = await initializeBrowser();
  const keywords = [...new Set(targetKeywords.map(x => x.toLowerCase()))];

  const allUrls = new Set();

  for (const keyword of keywords) {
    const urls = await scrapeUrlsForKeyword(page, keyword);
    urls.forEach(url => allUrls.add(url));
  }

  // Save to file
  if (allUrls.size > 0) {
    fs.writeFileSync(outputFile, Array.from(allUrls).join('\n'), 'utf-8');
    logAny(`Saved ${allUrls.size} tweet URLs to ${outputFile}`);
  } else {
    logAny('No tweet URLs found for any keyword.');
  }

  await browser.close();
  logAny("Exited gracefully. Goodbye!");
};

main();
