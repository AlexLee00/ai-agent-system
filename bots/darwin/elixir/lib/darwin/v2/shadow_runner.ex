defmodule Darwin.V2.ShadowRunner do
  @moduledoc """
  다윈 Shadow Mode (Phase 6) — V1(TeamJay.Darwin) vs V2(Darwin.V2) 병행 비교.

  DARWIN_SHADOW_ENABLED=true 시 활성화.

  동작:
  1. paper_discovered 이벤트 수신
  2. V1: TeamJay.Darwin.Evaluator (PortAgent → research-evaluator.ts) 결과 읽기
  3. V2: Darwin.V2.LLM.Selector 직접 호출로 동일 논문 평가
  4. 점수 비교 → match_score 계산
  5. darwin_v2_shadow_runs 테이블에 기록
  6. 7일 누적 후: avg match_score ≥ 95% → 마스터 알림 (V2 전환 권고)

  매칭 기준: |v1_score - v2_score| ≤ 1 → match (10점 스케일에서 ±1 허용)
  """

  use GenServer
  require Logger

  alias TeamJay.Repo

  @match_tolerance 1       # 점수 차이 ≤ 1이면 일치
  @promotion_days  7       # Shadow 관찰 기간
  @promotion_score 0.95    # 승격 기준 match rate

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "수동 Shadow 실행."
  def run_once do
    GenServer.cast(__MODULE__, :run_once)
  end

  @doc "Shadow 통계 조회 (지난 7일)."
  def stats do
    GenServer.call(__MODULE__, :stats)
  end

  @doc "Shadow 모드 활성화 여부."
  def enabled? do
    System.get_env("DARWIN_SHADOW_ENABLED", "false") == "true"
  end

  @impl GenServer
  def init(_opts) do
    if enabled?() do
      Logger.info("[darwin/shadow] Shadow Runner 시작 — V1 vs V2 병행 비교 모드")
      Process.send_after(self(), :subscribe, 3_000)
    else
      Logger.debug("[darwin/shadow] Shadow Runner 대기 (DARWIN_SHADOW_ENABLED=false)")
    end

    {:ok, %{runs: 0, last_run_at: nil}}
  end

  @impl GenServer
  def handle_info(:subscribe, state) do
    Registry.register(TeamJay.JayBus, "darwin.paper.evaluated", [])
    Logger.debug("[darwin/shadow] JayBus 구독 완료 (darwin.paper.evaluated)")
    {:noreply, state}
  end

  def handle_info({:jay_event, "darwin.paper.evaluated", payload}, state) do
    if enabled?() do
      paper = payload[:paper] || payload
      v1_score = paper["score"] || paper[:score]
      Task.start(fn -> run_shadow_eval(paper, v1_score) end)
    end

    {:noreply, %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast(:run_once, state) do
    if enabled?(), do: Task.start(fn -> run_shadow_batch() end)
    {:noreply, %{state | runs: state.runs + 1}}
  end

  @impl GenServer
  def handle_call(:stats, _from, state) do
    {:reply, Map.merge(state, compute_stats()), state}
  end

  # -------------------------------------------------------------------
  # Private — Shadow 평가
  # -------------------------------------------------------------------

  defp run_shadow_eval(paper, v1_score) when is_number(v1_score) do
    title  = paper["title"] || paper[:title] || "unknown"
    source = paper["source"] || paper[:source] || "unknown"

    prompt = build_eval_prompt(title, source)

    case Darwin.V2.LLM.Selector.call_with_fallback(
           "darwin.evaluator",
           prompt,
           max_tokens: 256,
           task_type: :evaluation_scoring
         ) do
      {:ok, %{response: text}} ->
        v2_score = parse_score(text)
        matched  = abs(v1_score - v2_score) <= @match_tolerance

        Logger.info("[darwin/shadow] #{title} — V1:#{v1_score} V2:#{v2_score} #{if matched, do: "✓", else: "✗"}")

        record_shadow_run(%{
          paper_title: title,
          v1_score:    v1_score,
          v2_score:    v2_score,
          matched:     matched
        })

        maybe_notify_promotion()

      {:error, :selector_disabled} ->
        Logger.debug("[darwin/shadow] V2 LLM 비활성 — Shadow 스킵")

      {:error, reason} ->
        Logger.warning("[darwin/shadow] V2 평가 실패 (#{title}): #{inspect(reason)}")
        record_shadow_run(%{paper_title: title, v1_score: v1_score, v2_score: nil, matched: false, error: inspect(reason)})
    end
  end

  defp run_shadow_eval(_paper, _), do: :ok

  defp run_shadow_batch do
    case Repo.query("""
      SELECT title, url, score, source
      FROM rag_research
      WHERE score IS NOT NULL
        AND created_at > NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM darwin_v2_shadow_runs
          WHERE cycle_result->>'paper_title' = rag_research.title
            AND run_date = CURRENT_DATE
        )
      ORDER BY created_at DESC
      LIMIT 10
    """, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        papers = Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)
        Logger.info("[darwin/shadow] 배치 Shadow 평가: #{length(papers)}건")
        Enum.each(papers, fn p -> run_shadow_eval(p, p["score"]) end)

      _ ->
        Logger.debug("[darwin/shadow] 배치 대상 없음")
    end
  end

  defp record_shadow_run(data) do
    Repo.query("""
      INSERT INTO darwin_v2_shadow_runs
        (run_date, cycle_result, match_score, notes, inserted_at, updated_at)
      VALUES (CURRENT_DATE, $1, $2, $3, NOW(), NOW())
    """, [
      Jason.encode!(data),
      if(data[:matched], do: 1.0, else: 0.0),
      "v1=#{data[:v1_score]} v2=#{data[:v2_score]}"
    ])
    |> case do
      {:ok, _} -> :ok
      {:error, e} -> Logger.warning("[darwin/shadow] 기록 실패: #{inspect(e)}")
    end
  end

  defp maybe_notify_promotion do
    stats = compute_stats()
    days  = stats[:observation_days] || 0
    rate  = stats[:match_rate] || 0.0

    if days >= @promotion_days and rate >= @promotion_score do
      Logger.info("[darwin/shadow] 🎉 V2 승격 조건 달성 — #{days}일 / #{Float.round(rate * 100, 1)}%")

      Task.start(fn ->
        try do
          TeamJay.HubClient.post_alarm(
            "🔬 다윈 V2 Shadow 7일 완료 — match_rate #{Float.round(rate * 100, 1)}%\n" <>
            "V2(Darwin.V2) 전환 승인 요청 (DARWIN_V2_ENABLED=true)",
            "darwin", "darwin_shadow"
          )
        rescue
          _ -> :ok
        end
      end)
    end
  end

  defp compute_stats do
    sql = """
    SELECT
      COUNT(*)                 AS total_runs,
      AVG(match_score)         AS avg_match_rate,
      COUNT(DISTINCT run_date) AS observation_days,
      MIN(run_date)            AS first_run,
      MAX(run_date)            AS last_run
    FROM darwin_v2_shadow_runs
    WHERE run_date >= CURRENT_DATE - INTERVAL '7 days'
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: [[total, avg_rate, days, first, last]]}} ->
        %{
          total_runs:          total || 0,
          match_rate:          if(is_number(avg_rate), do: avg_rate, else: 0.0),
          observation_days:    days || 0,
          first_run:           first,
          last_run:            last,
          ready_for_promotion: (days || 0) >= @promotion_days and (avg_rate || 0.0) >= @promotion_score
        }

      _ ->
        %{total_runs: 0, match_rate: 0.0, observation_days: 0, ready_for_promotion: false}
    end
  rescue
    _ -> %{total_runs: 0, match_rate: 0.0, observation_days: 0, ready_for_promotion: false}
  end

  # -------------------------------------------------------------------
  # Private — 유틸
  # -------------------------------------------------------------------

  defp build_eval_prompt(title, source) do
    """
    다음 논문이 AI 에이전트 시스템(루나/블로/스카/시그마/다윈팀) 개선에 적합한지 평가하세요.

    제목: #{title}
    출처: #{source}

    다음 형식으로만 답하세요:
    점수: (0-10 정수)
    이유: (한 줄)
    """
  end

  defp parse_score(text) do
    case Regex.run(~r/점수:\s*(\d+)/u, text) do
      [_, s] -> String.to_integer(s) |> min(10) |> max(0)
      _ ->
        case Regex.run(~r/(\d+)\s*\/\s*10/u, text) do
          [_, s] -> String.to_integer(s) |> min(10) |> max(0)
          _      -> 5
        end
    end
  end
end
