'use strict';
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseNaverEditorDocumentFromFile,
  blocksFromHtml,
  buildPlainTextForEditor,
} = require('../lib/naver-ui/html-to-editor-blocks.ts');
const {
  assertSafeScheduledAt,
  resolveSafeScheduledAt,
  formatKstScheduleFields,
} = require('../lib/naver-ui/scheduled-publish-policy.ts');
const {
  buildWriteUrl,
  runNaverScheduledPublishAssist,
} = require('../lib/naver-ui/driver.ts');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naver-publish-assist-'));
  const imagePath = path.join(tmpDir, 'cover.png');
  const htmlPath = path.join(tmpDir, 'sample.html');
  fs.writeFileSync(imagePath, 'not-a-real-image', 'utf8');
  fs.writeFileSync(htmlPath, `
    <!doctype html>
    <html>
      <head><title>테스트 제목</title></head>
      <body>
        <h1>테스트 제목</h1>
        <p>첫 문단입니다.</p>
        <h2>소제목</h2>
        <pre><code>console.log('ok')</code></pre>
        <img src="./cover.png" />
      </body>
    </html>
  `, 'utf8');

  const document = parseNaverEditorDocumentFromFile(htmlPath);
  assert.equal(document.title, '테스트 제목');
  assert.ok(document.blocks.some((block) => block.type === 'heading' && block.text === '소제목'));
  assert.ok(document.blocks.some((block) => block.type === 'code' && /console\.log/.test(block.text)));
  assert.deepEqual(document.imagePaths, [imagePath]);
  assert.ok(document.plainText.includes('첫 문단입니다.'));

  const blocks = blocksFromHtml('<p>Alpha</p><hr><p>Beta</p>');
  assert.equal(blocks.filter((block) => block.type === 'paragraph').length, 2);
  assert.ok(buildPlainTextForEditor(blocks).includes('Alpha'));

  const now = new Date('2026-05-11T00:00:00.000Z');
  const safeScheduledAt = resolveSafeScheduledAt({ now, minDays: 5, hour: 7, minute: 0 });
  const fields = formatKstScheduleFields(safeScheduledAt);
  assert.equal(fields.date >= '2026-05-16', true);
  assert.doesNotThrow(() => assertSafeScheduledAt(safeScheduledAt, { now, minDays: 5 }));
  assert.throws(
    () => assertSafeScheduledAt('2026-05-14T00:00:00.000Z', { now, minDays: 5 }),
    /schedule_date_too_soon/,
  );

  assert.equal(
    buildWriteUrl({
      blogId: 'cafe_library',
      writeUrlTemplate: 'https://blog.naver.com/PostWriteForm.naver?blogId={blogId}',
    }),
    'https://blog.naver.com/PostWriteForm.naver?blogId=cafe_library',
  );

  const dryRun = await runNaverScheduledPublishAssist({
    document,
    scheduledAt: safeScheduledAt,
    dryRun: true,
    apply: false,
    config: {
      enabled: false,
      blogId: 'cafe_library',
      writeUrlTemplate: 'https://blog.naver.com/PostWriteForm.naver?blogId={blogId}',
      minScheduleDays: 5,
      clickFinalPublish: false,
    },
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.status, 'dry_run_plan');
  assert.equal(dryRun.confirmRequired, 'naver-scheduled-publish-assist');
  assert.equal(dryRun.schedule.date, fields.date);
  assert.ok(dryRun.actions.includes('click_final_publish_when_confirmed'));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: true, safeScheduledAt, blockCount: document.blocks.length }, null, 2));
  } else {
    console.log('[naver-publish-assist-smoke] ok');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
