const puppeteer = require('puppeteer');
const { loadSecrets } = require('./lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const delay = ms => new Promise(r => setTimeout(r, ms));

const SECRETS = loadSecrets();
(async () => {
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  setupDialogHandler(page, console.log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2' });
  await delay(2000);

  const info = await page.evaluate(() => {
    const notHidden = (el) => el.type !== 'hidden';

    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(notHidden)
      .map(el => ({ name: el.name, id: el.id, type: el.type, value: el.value, placeholder: el.placeholder }));

    const forms = Array.from(document.querySelectorAll('form'))
      .map(f => ({ action: f.action, method: f.method, id: f.id, name: f.name }));

    const selects = Array.from(document.querySelectorAll('select'))
      .map(el => ({
        name: el.name, id: el.id,
        options: Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() })).slice(0, 5)
      }));

    return { inputs, forms, selects };
  });

  console.log('=== FORMS ===');
  console.log(JSON.stringify(info.forms, null, 2));

  console.log('\n=== TEXT/DATE/NUMBER INPUTS ===');
  const textInputs = info.inputs.filter(i => ['text', 'date', 'number'].includes(i.type));
  console.log(JSON.stringify(textInputs, null, 2));

  console.log('\n=== SUBMIT INPUTS ===');
  const submitInputs = info.inputs.filter(i => i.type === 'submit');
  console.log(JSON.stringify(submitInputs, null, 2));

  console.log('\n=== SELECTS ===');
  console.log(JSON.stringify(info.selects, null, 2));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
