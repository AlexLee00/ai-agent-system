async function loginToPickko(page, id, pw, delay) {
  await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((id, pw) => {
    document.getElementById('mn_id').value = id;
    document.getElementById('mn_pw').value = pw;
    document.getElementById('loginButton').click();
  }, id, pw);
  await delay(3000);
}

module.exports = { loginToPickko };
