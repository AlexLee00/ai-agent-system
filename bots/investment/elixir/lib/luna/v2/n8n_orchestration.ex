defmodule Luna.V2.N8nOrchestration do
  @moduledoc """
  n8n 워크플로우 오케스트레이션 클라이언트.

  원칙: n8n은 orchestration + 리포트만.
  core decision path는 Elixir/Jido 유지.

  워크플로우:
  - luna-weekly-review: 매주 일요일 18:00 KST 자동 실행
  - luna-daily-report:  매일 07:00 KST 일일 리포트
  """
  require Logger

  @n8n_base_default "http://localhost:5678"

  @doc "주간 리뷰 트리거."
  def trigger_weekly_review(opts \\ []) do
    payload = %{
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601(),
      source: "luna_weekly",
      opts: opts
    }
    call_webhook("luna-weekly-review", payload)
  end

  @doc "일일 리포트 트리거."
  def trigger_daily_report(summary \\ %{}) do
    payload = Map.merge(%{
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601(),
      source: "luna_daily"
    }, summary)
    call_webhook("luna-daily-report", payload)
  end

  @doc "Validation 완료 알림."
  def notify_validation_complete(strategy_id, verdict) do
    payload = %{
      strategy_id: strategy_id,
      verdict: verdict,
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601()
    }
    call_webhook("luna-validation-complete", payload)
  end

  # ─── Internal ───────────────────────────────────────────────────

  defp call_webhook(path, payload) do
    n8n_base = System.get_env("N8N_BASE_URL", @n8n_base_default)

    case Req.post("#{n8n_base}/webhook/#{path}",
           json: payload,
           receive_timeout: 10_000) do
      {:ok, %Req.Response{status: status}} when status in 200..299 ->
        Logger.info("[N8n] webhook #{path} 성공 (#{status})")
        {:ok, :triggered}
      {:ok, %Req.Response{status: status}} ->
        Logger.warning("[N8n] webhook #{path} HTTP #{status}")
        {:error, "HTTP #{status}"}
      {:error, err} ->
        Logger.warning("[N8n] webhook #{path} 실패: #{inspect(err)}")
        {:error, inspect(err)}
    end
  end
end
