// @ts-nocheck
'use strict';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function run(input = {}) {
  const changedFiles = toArray(input.changedFiles);
  const findings = toArray(input.findings);
  const tests = toArray(input.tests);
  const highFindings = findings.filter((item) => String(item?.severity || '').toLowerCase() === 'high');
  const blockingFindings = findings.filter((item) => ['critical', 'high'].includes(String(item?.severity || '').toLowerCase()));
  const testsRan = tests.length > 0;

  const assertions = [
    {
      key: 'high_severity_findings',
      ok: highFindings.length === 0,
      value: highFindings.length,
      note: highFindings.length ? 'High severity findings must be addressed before shipping.' : 'No high severity findings.',
    },
    {
      key: 'tests_executed',
      ok: testsRan,
      value: tests.length,
      note: testsRan ? 'At least one validation step executed.' : 'No tests or verification steps were recorded.',
    },
    {
      key: 'ship_blockers',
      ok: blockingFindings.length === 0,
      value: blockingFindings.length,
      note: blockingFindings.length ? 'Blocking findings remain.' : 'No blocking findings remain.',
    },
  ];

  const failures = [];
  if (highFindings.length) failures.push(`high severity findings: ${highFindings.length}`);
  if (!testsRan) failures.push('tests not executed');
  if (blockingFindings.length) failures.push(`ship blockers: ${blockingFindings.length}`);

  const evidence = [
    `scope=${input.scope || 'unknown'}`,
    `changed_files=${changedFiles.length}`,
    `findings=${findings.length}`,
    `tests=${tests.length}`,
  ];

  const nextActions = [];
  if (highFindings.length) nextActions.push('Resolve high severity findings before merge.');
  if (!testsRan) nextActions.push('Run at least one syntax, unit, or smoke validation step.');
  if (!blockingFindings.length && testsRan) nextActions.push('Prepare QA or ship workflow if release is intended.');

  let finalVerdict = 'pass';
  if (blockingFindings.length) {
    finalVerdict = 'fail';
  } else if (!testsRan || findings.length) {
    finalVerdict = 'warn';
  }

  return {
    workflow: 'review-workflow',
    inputs: {
      scope: input.scope || null,
      changedFiles,
      findings,
      tests,
    },
    assertions,
    evidence,
    failures,
    finalVerdict,
    nextActions,
  };
}

module.exports = {
  run,
};
