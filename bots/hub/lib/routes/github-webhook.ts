/**
 * POST /github/webhook — GitHub Issues Webhook 수신 엔드포인트
 *
 * Hub Bearer 인증 범위 밖(/hub/ 아님) — GitHub Webhook Signature로 검증
 * GITHUB_WEBHOOK_SECRET 설정 시 X-Hub-Signature-256 검증 필수
 */

const {
  handleIssueOpened,
  handleIssueClosed,
  handleIssueReopened,
  handleIssueLabeled,
  verifyGithubSignature,
} = require('../webhooks/github-issues');

export async function githubWebhookRoute(req: any, res: any) {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const event = req.headers['x-github-event'] as string | undefined;
  const rawBody: Buffer | undefined = req.rawBody;
  const hasSecret = !!process.env.GITHUB_WEBHOOK_SECRET;

  if (hasSecret) {
    if (!rawBody) {
      console.error('[github-webhook] GITHUB_WEBHOOK_SECRET 설정됐으나 rawBody 없음');
      return res.status(500).json({ ok: false, error: 'server config error: rawBody unavailable' });
    }
    if (!verifyGithubSignature(rawBody, signature)) {
      console.warn('[github-webhook] 서명 검증 실패');
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }
  }

  if (event !== 'issues') {
    return res.json({ ok: true, skipped: true, event });
  }

  const payload = req.body || {};
  const action: string = String(payload.action || '');
  const issue = payload.issue;
  const repo: string = String(payload.repository?.full_name || '');

  if (!issue) {
    return res.status(400).json({ ok: false, error: 'issue payload 없음' });
  }

  try {
    switch (action) {
      case 'opened':
        await handleIssueOpened(issue, repo);
        break;
      case 'closed':
        await handleIssueClosed(issue);
        break;
      case 'reopened':
        await handleIssueReopened(issue);
        break;
      case 'labeled':
      case 'unlabeled':
        await handleIssueLabeled(issue);
        break;
      default:
        return res.json({ ok: true, skipped: true, action });
    }

    return res.json({ ok: true, action, issue_number: issue.number });
  } catch (err: any) {
    console.error('[github-webhook] 처리 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
