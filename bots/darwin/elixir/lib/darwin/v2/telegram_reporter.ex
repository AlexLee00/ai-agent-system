defmodule Darwin.V2.TelegramReporter do
  @moduledoc """
  다윈팀 Telegram 리포트 — 5 채널 패턴 (루나팀 적용, Phase O).

  채널:
  1. urgent  — 원칙 위반, 사이클 실패, 자율 레벨 승격 후보
  2. hourly  — 진행 중 사이클 상태 (현재 미구현, Phase M에서 확장)
  3. daily   — 일일 리포트 (06:30 KST, darwin-daily-report.ts에서 호출)
  4. weekly  — 주간 리뷰 (일요일 19:00 KST, darwin-weekly-review.ts에서 호출)
  5. meta    — ESPL/Self-Rewarding 재조정 결과, Recommender 변화

  Kill Switch: DARWIN_TELEGRAM_ENHANCED=true
  비활성 시: TelegramBridge.notify/2 (기존 경량 알림) 경유.
  """

  require Logger
  alias Darwin.V2.{KillSwitch, TelegramBridge}

  # ─────────────────────────────────────────────────
  # Urgent 채널 (Kill Switch 무관 — 항상 발송)
  # ─────────────────────────────────────────────────

  @doc "사이클 실패 즉시 알림."
  @spec on_cycle_failure(map(), term()) :: :ok
  def on_cycle_failure(cycle, reason) do
    msg = "🧬 다윈 사이클 실패\n논문: #{cycle[:paper_title] || "N/A"}\n이유: #{inspect(reason)}"
    send_urgent(msg)
  end

  @doc "원칙 위반 즉시 알림."
  @spec on_principle_violation(String.t(), map()) :: :ok
  def on_principle_violation(agent, violation) do
    msg = "🚨 다윈 원칙 위반\n에이전트: #{agent}\n내용: #{violation[:description] || inspect(violation)}"
    send_urgent(msg)
  end

  @doc "자율 레벨 승격 후보 감지 알림 (자동 flip 절대 금지)."
  @spec on_promotion_candidate(integer(), integer(), map()) :: :ok
  def on_promotion_candidate(from_level, to_level, stats) do
    msg = """
    🧬 다윈 자율 레벨 승격 후보 감지
    현재: L#{from_level} → 제안: L#{to_level}
    - 성공 사이클: #{stats[:successes]}회
    - 적용 완료: #{stats[:applications]}회
    - 경과 일수: #{stats[:days]}일
    마스터 승인 후 DARWIN_AUTONOMY_LEVEL=#{to_level} 적용
    """
    send_urgent(msg)
  end

  # ─────────────────────────────────────────────────
  # Daily 채널 (Kill Switch 제어)
  # ─────────────────────────────────────────────────

  @doc "일일 리포트 발송 (darwin-daily-report.ts에서 호출)."
  @spec on_daily_report(map()) :: :ok
  def on_daily_report(stats) do
    unless KillSwitch.enabled?(:telegram_enhanced) do
      Logger.debug("[Darwin.V2.TelegramReporter] telegram_enhanced OFF — 일일 리포트 스킵")
      :ok
    else
      msg = format_daily(stats)
      send_general(msg)
    end
  end

  # ─────────────────────────────────────────────────
  # Weekly 채널 (Kill Switch 제어)
  # ─────────────────────────────────────────────────

  @doc "주간 리뷰 발송 (darwin-weekly-review.ts에서 호출)."
  @spec on_weekly_review(map()) :: :ok
  def on_weekly_review(stats) do
    unless KillSwitch.enabled?(:telegram_enhanced) do
      Logger.debug("[Darwin.V2.TelegramReporter] telegram_enhanced OFF — 주간 리뷰 스킵")
      :ok
    else
      msg = format_weekly(stats)
      send_general(msg)
    end
  end

  # ─────────────────────────────────────────────────
  # Meta 채널 (Kill Switch 제어)
  # ─────────────────────────────────────────────────

  @doc "ESPL/Self-Rewarding/Recommender 변화 알림."
  @spec on_meta_change(String.t(), map()) :: :ok
  def on_meta_change(type, data) do
    unless KillSwitch.enabled?(:telegram_enhanced), do: :ok

    msg = "🧬 다윈 메타 변화: #{type}\n#{format_meta_data(data)}"
    send_general(msg)
  end

  # ─────────────────────────────────────────────────
  # Private — 메시지 발송
  # ─────────────────────────────────────────────────

  defp send_urgent(msg) do
    try do
      TelegramBridge.notify("darwin_urgent", msg)
    rescue
      e -> Logger.warning("[Darwin.V2.TelegramReporter] urgent 발송 실패: #{inspect(e)}")
    end
    :ok
  end

  defp send_general(msg) do
    try do
      TelegramBridge.notify("darwin_general", msg)
    rescue
      e -> Logger.warning("[Darwin.V2.TelegramReporter] general 발송 실패: #{inspect(e)}")
    end
    :ok
  end

  # ─────────────────────────────────────────────────
  # Private — 메시지 포맷터
  # ─────────────────────────────────────────────────

  defp format_daily(stats) do
    """
    📊 다윈 일일 리포트 (#{stats[:date] || "today"})

    🔬 사이클:
      총 #{stats[:total_cycles] || 0}회 | 성공: #{stats[:successes] || 0} (#{stats[:success_rate] || "N/A"}%) | 실패: #{stats[:failures] || 0}
      적용: #{stats[:applied] || 0}건

    💰 LLM 비용: $#{stats[:llm_cost_usd] || 0}

    🎯 자율 레벨: L#{stats[:autonomy_level] || 3}

    📚 Research Registry:
      신규 발견: #{stats[:new_papers] || 0} | 평가 완료: #{stats[:evaluated] || 0} | 구현 대기: #{stats[:planned] || 0}

    ⚠️ 원칙 위반: #{stats[:violations] || 0}회
    """
  end

  defp format_weekly(stats) do
    """
    📅 다윈 주간 리뷰 (#{stats[:week] || "this week"})

    🔬 사이클 요약:
      총 #{stats[:total_cycles] || 0}회 | 성공률: #{stats[:success_rate] || "N/A"}%
      적용 완료: #{stats[:applied] || 0}건

    📚 Research Registry 변화:
      신규 논문: #{stats[:new_papers] || 0} | 적용된 논문: #{stats[:applied_papers] || 0}

    🧠 Self-Rewarding DPO:
      preferred: #{stats[:preferred_pairs] || 0} | rejected: #{stats[:rejected_pairs] || 0}

    🔄 Shadow Mode (V1 vs V2):
      일치율: #{stats[:shadow_match_rate] || "N/A"}%

    💰 주간 LLM 비용: $#{stats[:weekly_cost_usd] || 0}
    """
  end

  defp format_meta_data(data) when is_map(data) do
    data
    |> Enum.map(fn {k, v} -> "  #{k}: #{v}" end)
    |> Enum.join("\n")
  end
  defp format_meta_data(data), do: inspect(data, pretty: true, limit: 200)
end
