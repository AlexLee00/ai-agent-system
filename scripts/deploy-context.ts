// @ts-nocheck
/**
 * deploy-context.js - 봇 컨텍스트 배포 (thin wrapper)
 * 상세 구현: scripts/lib/deployer.js
 *
 * 사용법:
 *   node scripts/deploy-context.js --list
 *   node scripts/deploy-context.js --bot=reservation
 *   node scripts/deploy-context.js --bot=reservation --target=claude-code
 *   node scripts/deploy-context.js --all
 *   node scripts/deploy-context.js --bot=reservation --sync
 */

const { loadRegistry, deployBot, syncBot, deployAll, listBots, log } = require('./lib');

const args      = process.argv.slice(2);
const botArg    = args.find(a => a.startsWith('--bot='))?.split('=')[1];
const targetArg = args.find(a => a.startsWith('--target='))?.split('=')[1];
const registry  = loadRegistry();

if      (args.includes('--list'))               listBots(registry);
else if (args.includes('--sync') && botArg)     syncBot(botArg, registry);
else if (botArg)                                deployBot(botArg, registry, targetArg || null);
else if (args.includes('--all'))                deployAll(registry);
else    console.log(`
사용법:
  node scripts/deploy-context.js --list
  node scripts/deploy-context.js --bot=reservation
  node scripts/deploy-context.js --bot=reservation --target=claude-code
  node scripts/deploy-context.js --all
  node scripts/deploy-context.js --bot=reservation --sync
`);
