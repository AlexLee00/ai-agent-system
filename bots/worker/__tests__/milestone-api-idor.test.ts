// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '../web/server.js');
const source = fs.readFileSync(target, 'utf8');

let pass = 0;
let fail = 0;

function assert(desc, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${desc}`);
    return;
  }
  fail++;
  console.error(`  ❌ ${desc}${detail ? `\n     ${detail}` : ''}`);
}

console.log('\n[ SEC-019 milestone API company scope ]');

const putRouteMatch = source.match(
  /app\.put\('\/api\/milestones\/:id',([\s\S]*?)\n\);/
);
const postRouteMatch = source.match(
  /app\.post\('\/api\/projects\/:id\/milestones',([\s\S]*?)\n\);/
);

assert(
  'PUT /api/milestones/:id route exists',
  Boolean(putRouteMatch),
);

assert(
  'POST /api/projects/:id/milestones route exists',
  Boolean(postRouteMatch),
);

const putRoute = putRouteMatch ? putRouteMatch[0] : '';
const postRoute = postRouteMatch ? postRouteMatch[0] : '';

assert(
  'PUT route applies companyFilter middleware',
  /app\.put\('\/api\/milestones\/:id',\s*[\s\S]*?companyFilter/.test(putRoute),
);

assert(
  'PUT route UPDATE query joins worker.projects for company scope',
  /UPDATE worker\.milestones AS m[\s\S]*?FROM worker\.projects AS p/.test(putRoute),
);

assert(
  'PUT route enforces p.company_id = \$7',
  /p\.company_id = \$7/.test(putRoute),
);

assert(
  'PUT route recalculates progress with req.companyId',
  /await recalcProgress\(row\.project_id,\s*req\.companyId\)/.test(putRoute),
);

assert(
  'POST route recalculates progress with req.companyId',
  /await recalcProgress\(req\.params\.id,\s*req\.companyId\)/.test(postRoute),
);

console.log(`\nSEC-019 결과: ✅ ${pass}건 통과 / ❌ ${fail}건 실패 / 총 ${pass + fail}건`);
if (fail > 0) process.exit(1);
