const delay = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = kst.toKST(new Date());
  console.log(`[${ts}] ${msg}`);
}

module.exports = { delay, log };
