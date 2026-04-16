'use strict';

// 소스 호환 레일 — dist 빌드를 직접 참조
// .ts 파일에서 require('../../lib/state-bus') 시 여기로 오지만,
// 실제 운영 런타임(dist)에서는 dist/ts-runtime/.../state-bus.js를 직접 씁니다.
const path = require('node:path');
module.exports = require(
  path.resolve(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/state-bus.js')
);
