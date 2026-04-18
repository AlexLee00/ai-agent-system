defmodule Sigma.V2.TelegramReporter do
  @moduledoc """
  시그마팀 Telegram 리포트 — 5채널 패턴 (다윈팀 Phase O 적용).

  채널:
  1. urgent — 원칙 위반, 사이클 실패, Tier 2 초과 적용
  2. daily  — 일일 편성 리포트 (매일 04:30 KST 발송 예정)
  3. weekly — 주간 메타리뷰 (일요일 MetaReview 완료 후)
  4. meta   — ESPL/Self-Rewarding 변화, Pod 성과 알림
  5. alert  — Directive 이행 미달, Pod 이상 감지

  Kill Switch: SIGMA_TELEGRAM_ENHANCED=true
  비활성 시: TelegramBridge.notify_pending / notify_meta_review 경유.
  """

  require Logger
  alias Sigma.V2.TelegramBridge

  # ─────────────────────────────────────────────────
  # Urgent 채널 (Kill Switch 무관 — 항상 발송)
  # ─────────────────────────────────────────────────

  @doc "MAPE-K 사이클 실패 즉시 알림."
  @spec on_cycle_failure(map(), term()) :: :ok
  def on_cycle_failure(cycle, reason) do
    msg = "🚨 시그마 사이클 실패\ncycle_id: #{cycle[:cycle_id] || "N/A"}\n이유: #{inspect(reason)}"
    send_urgent(msg)
  end

  @doc "원칙 위반 즉시 알림."
  @spec on_principle_violation(String.t(), map()) :: :ok
  def on_principle_violation(analyst, violation) do
    msg = "🚨 시그마 원칙 위반\n분석가: #{analyst}\n내용: #{violation[:description] || inspect(violation)}"
    send_urgent(msg)
  end

  @doc "Tier 2 자동 적용 한도 초과 알림."
  @spec on_tier2_limit_exceeded(String.t(), integer()) :: :ok
  def on_tier2_limit_exceeded(team, count) do
    msg = "⚠️ 시그마 Tier2 한도 초과\n팀: #{team}\n오늘 적용 #{count}건 (한도: 3건)"
    send_urgent(msg)
  end

  # ─────────────────────────────────────────────────
  # Daily 채널 (Kill Switch 제어)
  # ─────────────────────────────────────────────────

  @doc "일일 리포트 발송."
  @spec on_daily_report(map()) :: :ok
  def on_daily_report(stats) do
    unless enhanced_enabled?() do
      Logger.debug("[Sigma.V2.TelegramReporter] telegram_enhanced OFF — 일일 리포트 스킵")
      :ok
    else
      send_general(format_daily(stats))
    end
  end

  # ─────────────────────────────────────────────────
  # Weekly 채널 (Kill Switch 제어)
  # ─────────────────────────────────────────────────

  @doc "주간 메타리뷰 발송."
  @spec on_weekly_review(map()) :: :ok
  def on_weekly_review(stats) do
    unless enhanced_enabled?() do
      Logger.debug("[Sigma.V2.TelegramReporter] telegram_enhanced OFF — 주간 리뷰 스킵")
      :ok
    else
      send_general(format_weekly(stats))
    end
  end

  # ─────────────────────────────────────────────────
  # Meta 채널 (Kill Switch 제어)
  # ─────────────────────────────────────────────────

  @doc "ESPL/Self-Rewarding/Pod 변화 알림."
  @spec on_meta_change(String.t(), map()) :: :ok
  def on_meta_change(type, data) do
    unless enhanced_enabled?() do
      :ok
    else
      msg = "🔬 시그마 메타 변화: #{type}\n#{format_meta_data(data)}"
      send_general(msg)
    end
  end

  # ─────────────────────────────────────────────────
  # Alert 채널 (Kill Switch 제어)
  # ─────────────────────────────────────────────────

  @doc "Directive 이행 미달 알림."
  @spec on_directive_unfulfilled(String.t(), String.t(), map()) :: :ok
  def on_directive_unfulfilled(team, directive_id, stats) do
    unless enhanced_enabled?() do
      :ok
    else
      msg = """
      📋 시그마 Directive 이행 미달
      팀: #{team}
      ID: #{directive_id}
      발행: #{stats[:issued_at] || "N/A"}
      확인된 이행: #{stats[:fulfilled] || false}
      """
      send_alert(msg)
    end
  end

  @doc "Pod 성과 이상 감지 알림."
  @spec on_pod_anomaly(String.t(), float(), float()) :: :ok
  def on_pod_anomaly(pod_name, current_score, baseline_score) do
    unless enhanced_enabled?() do
      :ok
    else
      diff = Float.round((current_score - baseline_score) * 1.0, 2)
      direction = if diff > 0, do: "↑", else: "↓"

      msg = """
      📊 시그마 Pod 성과 변화
      Pod: #{pod_name}
      현재 정확도: #{Float.round(current_score * 1.0, 2)}
      기준 대비: #{direction}#{abs(diff)}
      """
      send_alert(msg)
    end
  end

  # ─────────────────────────────────────────────────
  # Private — 발송
  # ─────────────────────────────────────────────────

  defp send_urgent(msg) do
    try do
      TelegramBridge.notify_pending(%{urgent: true, msg: msg}, "sigma_urgent")
    rescue
      _ ->
        try do
          Jay.Core.HubClient.post_alarm("[URGENT] #{msg}", "sigma", "elixir")
        rescue
          e -> Logger.warning("[Sigma.V2.TelegramReporter] urgent 발송 실패: #{inspect(e)}")
        end
    end
    :ok
  end

  defp send_general(msg) do
    try do
      Jay.Core.HubClient.post_alarm(msg, "sigma", "elixir")
    rescue
      e -> Logger.warning("[Sigma.V2.TelegramReporter] general 발송 실패: #{inspect(e)}")
    end
    :ok
  end

  defp send_alert(msg) do
    try do
      Jay.Core.HubClient.post_alarm("[ALERT] #{msg}", "sigma", "elixir")
    rescue
      e -> Logger.warning("[Sigma.V2.TelegramReporter] alert 발송 실패: #{inspect(e)}")
    end
    :ok
  end

  # ─────────────────────────────────────────────────
  # Private — 메시지 포맷터
  # ─────────────────────────────────────────────────

  defp format_daily(stats) do
    """
    📋 시그마 일일 편성 리포트 (#{stats[:date] || "today"})

    🎯 MAPE-K 사이클:
      총 #{stats[:total_cycles] || 0}회 | 성공: #{stats[:success_count] || 0} | 실패: #{stats[:error_count] || 0}
      Directive 발행: #{stats[:directive_count] || 0}건

    🏢 관찰 팀: #{format_teams(stats[:target_teams])}

    🤖 Pod 편성:
      Trend: #{stats[:trend_analysts] || "N/A"} | Growth: #{stats[:growth_analysts] || "N/A"} | Risk: #{stats[:risk_analysts] || "N/A"}

    💰 LLM 비용: $#{stats[:llm_cost_usd] || 0}

    ⚠️ 원칙 위반: #{stats[:violations] || 0}회
    """
  end

  defp format_weekly(stats) do
    """
    📅 시그마 주간 메타리뷰 (#{stats[:week] || "this week"})

    🎯 Directive 성과:
      총 #{stats[:total_directives] || 0}건 | 수락률: #{stats[:acceptance_rate] || "N/A"}%
      Tier2 자동 적용: #{stats[:tier2_applied] || 0}건

    🤖 Pod 정확도:
      Trend: #{stats[:trend_accuracy] || "N/A"} | Growth: #{stats[:growth_accuracy] || "N/A"} | Risk: #{stats[:risk_accuracy] || "N/A"}

    🧠 Self-Rewarding DPO:
      preferred: #{stats[:preferred_pairs] || 0} | rejected: #{stats[:rejected_pairs] || 0}

    🔄 ESPL 진화:
      generation: #{stats[:espl_generation] || "N/A"} | max_fitness: #{stats[:espl_max_fitness] || "N/A"}

    💰 주간 LLM 비용: $#{stats[:weekly_cost_usd] || 0}
    """
  end

  defp format_meta_data(data) when is_map(data) do
    data
    |> Enum.map(fn {k, v} -> "  #{k}: #{v}" end)
    |> Enum.join("\n")
  end
  defp format_meta_data(data), do: inspect(data, pretty: true, limit: 200)

  defp format_teams(nil), do: "없음"
  defp format_teams([]), do: "없음"
  defp format_teams(teams) when is_list(teams), do: Enum.join(teams, ", ")
  defp format_teams(teams), do: to_string(teams)

  defp enhanced_enabled? do
    System.get_env("SIGMA_TELEGRAM_ENHANCED") == "true"
  end
end
