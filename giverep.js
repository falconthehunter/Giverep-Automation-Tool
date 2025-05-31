import puppeteer from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

// --- Configurations ---
const chromiumPath = '/usr/bin/chromium';
const tweetsFile = path.join(process.cwd(), 'tweets_to_reply.txt');
const commentsFilePath = path.join(process.cwd(), 'comments.txt');
const authFilePath = path.join(process.cwd(), 'auth.json');
const proxy = process.env.HTTP_PROXY || '';
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
];

// --- Logging ---
function logInfo(msg) {
  console.log(chalk.green(msg));
}
function logError(msg) {
  console.error(chalk.red(msg));
}
function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// --- Load files ---
if (!fs.existsSync(tweetsFile)) {
  logError("Missing tweets_to_reply.txt file! Run the scraping script first.");
  process.exit(1);
}
if (!fs.existsSync(commentsFilePath)) {
  logError("Missing comments.txt file!");
  process.exit(1);
}
if (!fs.existsSync(authFilePath)) {
  logError("Missing auth.json file!");
  process.exit(1);
}
const tweetUrls = fs.readFileSync(tweetsFile, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean);
const cannedComments = fs.readFileSync(commentsFilePath, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean);
const authData = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
if (!authData.auth_token || !authData.ct0) {
  logError("auth.json must have both 'auth_token' and 'ct0'!");
  process.exit(1);
}
const twitterCookieData = [
  { name: 'ct0', value: authData.ct0, domain: '.x.com' },
  { name: 'auth_token', value: authData.auth_token, domain: '.x.com' }
];
function getCannedReply() {
  return cannedComments[Math.floor(Math.random() * cannedComments.length)];
}
function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

puppeteerExtra.use(StealthPlugin());

async function initializeBrowser() {
  const launchArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080'
  ];
  if (proxy) {
    launchArgs.push(`--proxy-server=${proxy}`);
    logInfo(`Using proxy: ${proxy}`);
  }
  const userAgent = getRandomUserAgent();
  logInfo(`User-Agent: ${userAgent}`);
  logInfo("Launching browser...");
  const browser = await puppeteerExtra.launch({
    headless: true,
    executablePath: chromiumPath,
    args: launchArgs
  });
  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  page.setDefaultNavigationTimeout(60000);

  logInfo("Opening https://x.com/ for login...");
  await page.goto('https://x.com/', { waitUntil: 'domcontentloaded' });
  logInfo("Setting Twitter auth cookies...");
  await page.setCookie(...twitterCookieData);
  logInfo("Reloading page to apply authentication...");
  await page.reload({ waitUntil: 'domcontentloaded' });
  await delay(2000);
  logInfo("Should be logged in now!");
  return { browser, page };
}

async function clickReplyButtonByLabel(page) {
  return await page.evaluate(() => {
    function isVisibleAndEnabled(btn) {
      const style = window.getComputedStyle(btn);
      return (
        style &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        !btn.disabled &&
        (!btn.hasAttribute('aria-disabled') || btn.getAttribute('aria-disabled') === 'false')
      );
    }
    const candidates = Array.from(document.querySelectorAll('div[role="dialog"] [role="button"], div[role="dialog"] button, div[role="dialog"] span'));
    for (const btn of candidates) {
      const text = btn.textContent ? btn.textContent.trim().toLowerCase() : '';
      const label = btn.getAttribute('aria-label') ? btn.getAttribute('aria-label').trim().toLowerCase() : '';
      if ((text === 'reply' || label === 'reply') && isVisibleAndEnabled(btn)) {
        btn.click();
        return true;
      }
    }
    return false;
  });
}

async function replyToTweet(browser, tweetUrl, replyText) {
  const match = tweetUrl.match(/status\/(\d+)/);
  if (!match) {
    logError(`Could not extract tweetId from url: ${tweetUrl}`);
    return false;
  }
  const tweetId = match[1];
  const replyUrl = `https://x.com/i/web/status/${tweetId}`;

  logInfo(`Opening tweet to reply: ${replyUrl}`);
  const page = await browser.newPage();
  await page.setUserAgent(getRandomUserAgent());

  try {
    await page.goto(replyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // --- Wait for the main tweet to load ---
    try {
      await page.waitForSelector('article', { timeout: 30000 });
    } catch {
      logError('Tweet article did not load within 30s. Skipping...');
      await page.screenshot({ path: `no_article_${tweetId}.png` });
      await page.close();
      return false;
    }
    await delay(1000); // Give a little more time for all sub-elements to render

    // --- Now scroll the tweet into view ---
    await page.evaluate(() => {
      const article = document.querySelector('article');
      if (article) article.scrollIntoView({behavior: "smooth", block: "center"});
    });
    await delay(800);

    await page.waitForSelector('[data-testid="reply"]', { timeout: 15000 });
    await page.click('[data-testid="reply"]');
    await delay(1000);

    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await page.type('[data-testid="tweetTextarea_0"]', replyText, { delay: 20 });

    const clicked = await clickReplyButtonByLabel(page);
    if (clicked) {
      logInfo(`Reply button detected and clicked for tweet ${tweetId}.`);
    } else {
      logError(`Reply button NOT found by label for tweet ${tweetId}.`);
      await page.screenshot({ path: `reply_error_${tweetId}.png` });
      await page.close();
      return false;
    }

    await delay(3000);
    await page.screenshot({ path: `reply_sent_${tweetId}.png` });

    await page.close();
    logInfo(`Replied to tweet: ${replyUrl}`);
    return true;
  } catch (e) {
    logError(`Error replying to tweet ${tweetUrl}: ${e}`);
    await page.screenshot({ path: `reply_error_${tweetId}.png` });
    await page.close();
    return false;
  }
}

const main = async () => {
  const { browser } = await initializeBrowser();

  for (const tweetUrl of tweetUrls) {
    const replyText = getCannedReply();
    logInfo(`Preparing to reply to tweet ${tweetUrl} with: "${replyText}"`);
    const success = await replyToTweet(browser, tweetUrl, replyText);
    if (!success) {
      logError(`Failed to reply to ${tweetUrl}`);
    }
    const replyDelay = Math.floor(Math.random() * 7000) + 5000; // 5-12 sec
    logInfo(`Waiting ${(replyDelay / 1000).toFixed(2)} seconds before next reply...`);
    await delay(replyDelay);
  }

  await browser.close();
  logInfo("Exited gracefully. Goodbye!");
};

main();
