const puppeteer = require('puppeteer');

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

  console.log('Navigating to http://localhost:58088...');
  await page.goto('http://localhost:58088');
  
  console.log('Waiting for load...');
  await new Promise(r => setTimeout(r, 2000));
  
  console.log('Clicking Start Try-On...');
  await page.evaluate(() => document.getElementById('startBtn').click());
  
  console.log('Waiting for AI load...');
  await new Promise(r => setTimeout(r, 5000));
  
  await browser.close();
  console.log('Done.');
})();
