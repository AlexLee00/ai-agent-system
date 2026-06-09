type FakePage = {
  evaluate: (fn: (options: unknown) => unknown, options: unknown) => Promise<unknown>;
  screenshot: () => Promise<Buffer>;
};

type AquaUIObservation = {
  ok?: boolean;
  mode?: string;
  visibleTextHash?: string;
  screenshotHash?: string;
  domSummary: {
    counts: {
      buttons: number;
    };
  };
};

type AquaUITraceRow = {
  id?: unknown;
};

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function createFakePage(): FakePage {
  return {
    evaluate: async (fn, options) => fn(options),
    screenshot: async () => Buffer.from('fake-screenshot'),
  };
}

async function main() {
  const liveDb = process.argv.includes('--live-db');
  const {
    collectAquaUIObservation,
    recordAquaUITrace,
  } = require('../../../packages/playwright-utils');

  (globalThis as any).document = {
    title: 'AQuaUI Smoke Dashboard',
    body: {
      innerText: 'Hub dashboard Trace 미발견 warning. 예약 상태 정상. 블로그 생성 장시간 작업 진행 중.',
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'a') {
        return [
          { innerText: 'Trace', textContent: 'Trace', href: 'http://localhost/trace' },
          { innerText: 'Dashboard', textContent: 'Dashboard', href: 'http://localhost/dashboard' },
        ];
      }
      if (selector === 'button,[role="button"],input[type="button"],input[type="submit"]') {
        return [
          { innerText: 'Refresh', textContent: 'Refresh', value: '', getAttribute: () => '', disabled: false },
        ];
      }
      if (selector === 'h1,h2,h3') {
        return [
          { tagName: 'H1', innerText: 'Hub Dashboard', textContent: 'Hub Dashboard' },
        ];
      }
      return [];
    },
  };
  (globalThis as any).location = { href: 'http://localhost/dashboard' };

  const observation = await collectAquaUIObservation(createFakePage(), {
    maxTextChars: 120,
    includeScreenshotHash: true,
  }) as AquaUIObservation;
  assert(observation.ok === true, 'expected aquaui observation ok');
  assert(observation.mode === 'aquaui', 'expected aquaui mode');
  assert(observation.visibleTextHash?.length === 64, 'expected visible text hash');
  assert(observation.screenshotHash?.length === 64, 'expected screenshot hash');
  assert(observation.domSummary.counts.buttons === 1, 'expected button summary');

  let dbRecordId: unknown = null;
  let dbSearchCount = null;
  if (liveDb) {
    dbRecordId = await recordAquaUITrace(observation, {
      team: 'hub',
      botName: 'aquaui-smoke',
      traceId: 'aquaui-smoke-live-db',
      scope: 'dashboard',
    });
    assert(dbRecordId, 'expected aquaui trace DB record id');
    const eventLake = require('../../../packages/core/lib/event-lake');
    const rows = await eventLake.search({
      eventType: 'aquaui_gui_trace',
      team: 'hub',
      botName: 'aquaui-smoke',
      minutes: 10,
      limit: 5,
    });
    dbSearchCount = rows.length;
    assert(rows.some((row: AquaUITraceRow) => String(row.id) === String(dbRecordId)), 'expected inserted aquaui trace searchable');
  }

  delete (globalThis as any).document;
  delete (globalThis as any).location;

  console.log(JSON.stringify({
    ok: true,
    visibleTextHash: observation.visibleTextHash,
    screenshotHash: observation.screenshotHash,
    counts: observation.domSummary.counts,
    dbRecordId,
    dbSearchCount,
  }, null, 2));
}

main().catch((error: unknown) => {
  delete (globalThis as any).document;
  delete (globalThis as any).location;
  console.error(error);
  process.exit(1);
});
