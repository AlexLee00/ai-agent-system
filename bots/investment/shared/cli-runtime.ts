// @ts-nocheck
import { fileURLToPath } from 'url';

function getErrorMessage(error) {
  if (error?.message) return error.message;
  return String(error);
}

export function isDirectExecution(importMetaUrl, argv1 = process.argv[1]) {
  return Boolean(argv1) && argv1 === fileURLToPath(importMetaUrl);
}

export async function runCliMain({
  before,
  run,
  onSuccess,
  onError,
  errorPrefix = '❌ 실행 오류:',
} = {}) {
  try {
    if (typeof before === 'function') {
      await before();
    }
    const result = await run();
    if (typeof onSuccess === 'function') {
      await onSuccess(result);
    }
    process.exit(0);
  } catch (error) {
    if (typeof onError === 'function') {
      await onError(error);
    } else {
      console.error(`${errorPrefix} ${getErrorMessage(error)}`);
    }
    process.exit(1);
  }
}

export default {
  isDirectExecution,
  runCliMain,
};
