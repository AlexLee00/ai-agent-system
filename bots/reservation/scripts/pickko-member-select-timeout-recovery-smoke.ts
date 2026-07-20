#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createPickkoMemberSelectionService,
} = require('../lib/pickko-member-selection-service.ts');

const MEMBER = {
  name: '테스트고객',
  phone: '01000000000',
};

function createPage(evaluateResults: Array<unknown | Error>) {
  return {
    keyboard: {
      press: async () => undefined,
    },
    async evaluate() {
      const result = evaluateResults.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function createFixture() {
  const logs: string[] = [];
  let registerCalls = 0;
  let notificationCalls = 0;
  const service = createPickkoMemberSelectionService({
    delay: async () => undefined,
    log: (message: string) => logs.push(message),
    maskName: (name: string) => name,
    maskPhone: (phone: string) => phone,
    sendErrorNotification: async () => {
      notificationCalls += 1;
    },
    buildStageError: (code: string, message: string) => {
      const error = new Error(message) as Error & { stageCode?: string };
      error.stageCode = code;
      return error;
    },
    registerNewMember: async () => {
      registerCalls += 1;
    },
  });

  return {
    service,
    logs,
    get registerCalls() { return registerCalls; },
    get notificationCalls() { return notificationCalls; },
  };
}

const details = {
  phoneNoHyphen: MEMBER.phone,
  customerName: MEMBER.name,
  date: '2026-07-26',
};

async function testSingleRecoverySuccess() {
  const fixture = createFixture();
  const timedOutPage = createPage([new Error('Runtime.callFunctionOn timed out')]);
  const recoveredPage = createPage([
    undefined,
    undefined,
    true,
    true,
    MEMBER,
  ]);
  let recoverCalls = 0;

  const result = await fixture.service.selectMemberWithTimeoutRecovery(timedOutPage, details, {
    recoverPage: async (failedPage: unknown) => {
      assert.strictEqual(failedPage, timedOutPage);
      recoverCalls += 1;
      return recoveredPage;
    },
  });

  assert.strictEqual(result.page, recoveredPage);
  assert.deepStrictEqual(result.memberInfo, MEMBER);
  assert.strictEqual(recoverCalls, 1);
  assert.strictEqual(fixture.registerCalls, 0, 'timeout recovery must not create a member');
  assert.strictEqual(fixture.notificationCalls, 0, 'the recovered first timeout must not alert');
  assert.ok(
    fixture.logs.some((message) => message.includes('protocol timeout') && message.includes('1회 재시도')),
    'timeout recovery must leave one diagnostic log',
  );
}

async function testNormalRegistrationPathUnchanged() {
  const fixture = createFixture();
  const page = createPage([
    undefined,
    false,
    undefined,
    undefined,
    true,
    true,
    MEMBER,
  ]);
  let recoverCalls = 0;

  const result = await fixture.service.selectMemberWithTimeoutRecovery(page, details, {
    recoverPage: async () => {
      recoverCalls += 1;
      return page;
    },
  });

  assert.strictEqual(result.page, page);
  assert.deepStrictEqual(result.memberInfo, MEMBER);
  assert.strictEqual(fixture.registerCalls, 1, 'the ordinary unregistered-member flow must remain intact');
  assert.strictEqual(recoverCalls, 0, 'the ordinary flow must not enter timeout recovery');
}

async function testRecoveryNeverCreatesMember() {
  const fixture = createFixture();
  const timedOutPage = createPage([new Error('ProtocolError: Runtime.callFunctionOn timed out')]);
  const recoveredPage = createPage([
    undefined,
    undefined,
    false,
  ]);

  await assert.rejects(
    fixture.service.selectMemberWithTimeoutRecovery(timedOutPage, details, {
      recoverPage: async () => recoveredPage,
    }),
    (error: Error & { stageCode?: string }) => error.stageCode === 'MEMBER_SELECT_RECOVERY_UNVERIFIED',
  );
  assert.strictEqual(fixture.registerCalls, 0, 'ambiguous recovery must fail closed before registration');
}

async function testSecondTimeoutEscapes() {
  const fixture = createFixture();
  const timedOutPage = createPage([new Error('Runtime.callFunctionOn timed out')]);
  const recoveredPage = createPage([
    undefined,
    new Error('Runtime.callFunctionOn timed out'),
  ]);

  await assert.rejects(
    fixture.service.selectMemberWithTimeoutRecovery(timedOutPage, details, {
      recoverPage: async () => recoveredPage,
    }),
    /Runtime\.callFunctionOn timed out/,
  );
  assert.strictEqual(fixture.registerCalls, 0);
}

async function testNonProtocolErrorEscapes() {
  const fixture = createFixture();
  const failedPage = createPage([new Error('member modal selector changed')]);
  let recoverCalls = 0;

  await assert.rejects(
    fixture.service.selectMemberWithTimeoutRecovery(failedPage, details, {
      recoverPage: async () => {
        recoverCalls += 1;
        return failedPage;
      },
    }),
    /member modal selector changed/,
  );
  assert.strictEqual(recoverCalls, 0, 'ordinary errors must not enter timeout recovery');
}

async function main() {
  await testSingleRecoverySuccess();
  await testNormalRegistrationPathUnchanged();
  await testRecoveryNeverCreatesMember();
  await testSecondTimeoutEscapes();
  await testNonProtocolErrorEscapes();

  const accurateSource = fs.readFileSync(
    path.resolve(__dirname, '../manual/reservation/pickko-accurate.ts'),
    'utf8',
  );
  assert.match(
    accurateSource,
    /selectMemberWithTimeoutRecovery\(page,[\s\S]+recoverPage:/,
    'accurate registration must wire the bounded member-select recovery path',
  );
  process.stdout.write('pickko-member-select-timeout-recovery-smoke: ok\n');
}

main().catch((error: Error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
