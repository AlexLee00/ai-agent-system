type Logger = (message: string) => void;

export type CreateNaverDetachedRecoveryServiceDeps = {
  log: Logger;
  rollbackProcessingEntries: () => Promise<any>;
  naverLogin: (page: any) => Promise<boolean>;
};

export function createNaverDetachedRecoveryService(deps: CreateNaverDetachedRecoveryServiceDeps) {
  const { log, rollbackProcessingEntries, naverLogin } = deps;

  async function recoverDetachedPage({
    page,
    browser,
    detachRetryCount,
  }: {
    page: any;
    browser: any;
    detachRetryCount: number;
  }) {
    if (detachRetryCount >= 3) {
      log(`🛑 detached 오류 ${detachRetryCount}회 누적 → start-ops.sh 재시작 위임`);
      await rollbackProcessingEntries();
      return { shouldExit: true, page };
    }

    log(`⚠️ detached 오류 (${detachRetryCount}/3) → 페이지 재생성 후 재시도`);
    try {
      await page.close().catch(() => {});
      const nextPage = await browser.newPage();
      await nextPage.setViewport({ width: 1920, height: 1080 });
      const reloggedIn = await naverLogin(nextPage);
      if (!reloggedIn) {
        log('❌ 재로그인 실패 → 재시작 위임');
        await rollbackProcessingEntries();
        return { shouldExit: true, page: nextPage };
      }
      log('✅ 페이지 재생성 + 재로그인 완료 → 모니터링 계속');
      return { shouldExit: false, page: nextPage };
    } catch (err: any) {
      log(`❌ 페이지 재생성 실패: ${err.message} → 재시작 위임`);
      await rollbackProcessingEntries();
      return { shouldExit: true, page };
    }
  }

  return {
    recoverDetachedPage,
  };
}
