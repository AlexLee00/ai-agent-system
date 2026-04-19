defmodule TeamJay.Ska.Rag.ResponseSynthesizer do
  @moduledoc """
  복구 전략 종합 — 다중 소스 문서에서 최적 복구 전략 합성.

  입력: scored_docs = [%{source:, content:, final_score:, ...}, ...]
  출력: {:ok, %{strategy: atom, confidence: float, rationale: string, actions: list}}
  """
  require Logger

  @doc "문서 목록에서 복구 전략 합성"
  def combine(scored_docs, failure_context) do
    if scored_docs == [] do
      {:ok, fallback_strategy(failure_context)}
    else
      # 상위 3개 문서로 전략 합성
      top_docs = Enum.take(scored_docs, 3)
      strategy = synthesize_from_docs(top_docs, failure_context)
      {:ok, strategy}
    end
  end

  # ─── 내부 ────────────────────────────────────────────────

  defp synthesize_from_docs(docs, failure_context) do
    agent = failure_context[:agent] || :unknown
    error = failure_context[:error] || :unknown

    # 소스 기반 전략 선택
    primary_source = docs |> List.first() |> Map.get(:source, :unknown)
    avg_confidence = Enum.sum(Enum.map(docs, & &1.final_score)) / length(docs)

    strategy = determine_strategy(agent, error, primary_source, docs)
    actions = build_action_list(strategy, agent, docs)
    rationale = build_rationale(docs, strategy)

    %{
      strategy: strategy,
      confidence: Float.round(avg_confidence, 3),
      rationale: rationale,
      actions: actions,
      primary_source: primary_source,
      doc_count: length(docs)
    }
  end

  defp determine_strategy(:andy, :session_expired, _, _), do: :naver_relogin
  defp determine_strategy(:andy, :parse_failed, :selector_history, _), do: :selector_rollback
  defp determine_strategy(:andy, :parse_failed, _, _), do: :selector_rollback
  defp determine_strategy(:jimmy, :kiosk_frozen, _, _), do: :kiosk_restart
  defp determine_strategy(:pickko, :db_disconnect, _, _), do: :pickko_reconnect
  defp determine_strategy(_, _, _, docs) do
    # 과거 성공 이력에서 전략 추론
    best = Enum.find(docs, fn d -> d[:source] == :past_recovery end)
    if best, do: :replay_past_success, else: :escalate_to_master
  end

  defp build_action_list(:naver_relogin, :andy, _) do
    [
      %{step: 1, action: "NaverRecovery.refresh_session/0 호출"},
      %{step: 2, action: "NaverSession 쿠키 갱신 확인"},
      %{step: 3, action: "다음 사이클 정상 처리 여부 모니터링"}
    ]
  end

  defp build_action_list(:selector_rollback, agent, _) do
    [
      %{step: 1, action: "SelectorManager.rollback_to_last_working(#{inspect(agent)}) 호출"},
      %{step: 2, action: "이전 버전 셀렉터로 파싱 재시도"},
      %{step: 3, action: "FailureLibrary에 셀렉터 실패 기록"}
    ]
  end

  defp build_action_list(:kiosk_restart, _, _) do
    [
      %{step: 1, action: "KioskBlockFlow 재초기화"},
      %{step: 2, action: "피코 API 연결 상태 재확인"},
      %{step: 3, action: "키오스크 재시작 명령 발행"}
    ]
  end

  defp build_action_list(:escalate_to_master, _, _) do
    [
      %{step: 1, action: "Telegram urgent 채널에 마스터 알림"},
      %{step: 2, action: "상세 에러 컨텍스트 첨부"},
      %{step: 3, action: "수동 개입 대기"}
    ]
  end

  defp build_action_list(_, _, _) do
    [%{step: 1, action: "표준 복구 흐름 실행"}]
  end

  defp build_rationale(docs, strategy) do
    sources = docs |> Enum.map(& &1.source) |> Enum.uniq() |> Enum.map(&to_string/1)
    "전략 #{strategy} — #{length(docs)}개 문서 참조 (소스: #{Enum.join(sources, ", ")})"
  end

  defp fallback_strategy(_failure_context) do
    %{
      strategy: :escalate_to_master,
      confidence: 0.1,
      rationale: "관련 복구 이력 없음 — 마스터 수동 개입 필요",
      actions: [%{step: 1, action: "Telegram urgent 알림"}],
      primary_source: :none,
      doc_count: 0
    }
  end
end
