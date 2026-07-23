export const PICKKO_REGISTER_FOLLOWUP_REQUIRED_CODE = 4;

export function resolvePickkoRegisterOutcome({
  pickkoExitCode,
  skipNaverBlock = false,
  asyncNaverBlock = false,
  naverBlockExitCode = null,
}: {
  pickkoExitCode: number | null;
  skipNaverBlock?: boolean;
  asyncNaverBlock?: boolean;
  naverBlockExitCode?: number | null;
}) {
  if (pickkoExitCode === 2) {
    return { success: false, pickkoRegistered: false, status: 'time_elapsed', exitCode: 2 };
  }

  const naverBlockOk = naverBlockExitCode == null
    ? skipNaverBlock || asyncNaverBlock
    : naverBlockExitCode === 0;
  if (!naverBlockOk) {
    return {
      success: false,
      pickkoRegistered: true,
      status: 'naver_block_pending',
      exitCode: PICKKO_REGISTER_FOLLOWUP_REQUIRED_CODE,
    };
  }

  return { success: true, pickkoRegistered: true, status: 'complete', exitCode: 0 };
}

export function classifyBatchRegisterExitCode(code: number | null) {
  if (code === 0) return 'complete';
  if (code === PICKKO_REGISTER_FOLLOWUP_REQUIRED_CODE) return 'registered_followup';
  if (code === 2) return 'terminal_failure';
  return 'retry_room';
}

export default {
  PICKKO_REGISTER_FOLLOWUP_REQUIRED_CODE,
  resolvePickkoRegisterOutcome,
  classifyBatchRegisterExitCode,
};
