defmodule Darwin.V2.ShadowRunner do
  @moduledoc """
  다윈 V2 Shadow Runner (Phase 6) — V1 vs V2 파이프라인 병행 비교.

  DARWIN_SHADOW_MODE=true 시 활성화.

  동작:
  1. JayBus "darwin.paper.evaluated" 이벤트 구독
  2. V1 평가 결과(paper_evaluated payload) 수신
  3. V2 평가 로직(Darwin.V2.LLM.Selector) 독립 실행 — JayBus 발행 없음
  4. Darwin.V2.ShadowCompare.compare/2 로 Jaccard match_score 계산
  5. darwin_v2_shadow_runs 테이블에 기록
  6. 7일·20건 누적 후 avg_match ≥ 95% → 마스터 텔레그램 알림

  매칭 기준:
  - 점수 차이 ≤ 1.0 → 일치
  - Jaccard 유사도(논문 집합) 가중 결합

  ## Public API
  - `get_match_score(days \\\\ 7)` — 최근 N일 평균 match_score
  - `shadow_summary()` — %{total_runs, avg_match, min_match, promotion_ready}
  - `run_comparison(paper)` — 단일 논문 즉시 비교
  - `shadow_ready?()` — 승격 준비 여부

  로그 prefix: [다윈V2 섀도우]
  """

  use GenServer
  require Logger

  alias TeamJay.{Repo, HubClient}
  alias Darwin.V2.ShadowCompare

  @match_tolerance    1.0
  @promotion_days     7
  @promotion_min_runs 20
  @promotion_score    0.95

  # -------------------------------------------------------------------
  # Public API
  # -------------------------------------------------------------------

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "활성화 여부 (DARWIN_SHADOW_MODE=true 런타임 환경변수 우선)."
  @spec enabled?() :: boolean()
  def enabled? do
    case System.get_env("DARWIN_SHADOW_MODE") do
      "true" -> true
      "false" -> false
      nil -> Application.get_env(:darwin, :shadow_mode, false)
    end
  end

  @doc "최근 N일 평균 match_score. 데이터 없으면 0.0."
  @spec get_match_score(pos_integer()) :: float()
  def get_match_score(days \\ 7) do
    GenServer.call(__MODULE__, {:get_match_score, days})
  end

  @doc "Shadow 종합 통계."
  @spec shadow_summary() :: map()
  def shadow_summary do
    GenServer.call(__MODULE__, :shadow_summary)
  end

  @doc "단일 논문 V1 vs V2 즉시 비교 (동기). Shadow 활성 여부 무관."
  @spec run_comparison(map()) :: map()
  def run_comparison(paper) do
    GenServer.call(__MODULE__, {:run_comparison, paper}, 30_000)
  end

  @doc "승격 조건 충족 여부 (avg_match ≥ 95% AND total_runs ≥ 20 AND days ≥ 7)."
  @spec shadow_ready?() :: boolean()
  def shadow_ready? do
    GenServer.call(__MODULE__, :shadow_ready)
  end

  # -------------------------------------------------------------------
  # GenServer callbacks
  # -------------------------------------------------------------------

  @impl GenServer
  def init(_opts) do
    if enabled?() do
      Logger.info("[다윈V2 섀도우] Shadow Runner 기동 — V1 vs V2 병행 비교 모드")
      Process.send_after(self(), :subscribe, 3_000)
    else
      Logger.debug("[다윈V2 섀도우] 대기 중 (DARWIN_SHADOW_MODE=false)")
    end

    {:ok, %{runs: 0, last_run_at: nil}}
  end

  @impl GenServer
  def handle_info(:subscribe, state) do
    Registry.register(Jay.Core.JayBus, "darwin.paper.evaluated", [])
    Logger.debug("[다윈V2 섀도우] JayBus 구독 완료 (darwin.paper.evaluated)")
    {:noreply, state}
  end

  def handle_info({:jay_event, "darwin.paper.evaluated", payload}, state) do
    if enabled?() do
      paper    = payload[:paper] || payload
      v1_score = paper["score"] || paper[:score]
      Task.start(fn -> do_shadow_eval(paper, v1_score) end)
    end

    {:noreply, %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_call({:get_match_score, days}, _from, state) do
    score = query_avg_match(days)
    {:reply, score, state}
  end

  def handle_call(:shadow_summary, _from, state) do
    summary = build_summary()
    {:reply, summary, state}
  end

  def handle_call({:run_comparison, paper}, _from, state) do
    result = do_run_comparison(paper)
    {:reply, result, state}
  end

  def handle_call(:shadow_ready, _from, state) do
    ready = check_promotion_ready()
    {:reply, ready, state}
  end

  # -------------------------------------------------------------------
  # Private — 핵심 로직
  # -------------------------------------------------------------------

  defp do_shadow_eval(paper, v1_score) when is_number(v1_score) do
    title  = paper["title"]  || paper[:title]  || "unknown"
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
        matched  = ShadowCompare.score_match?(v1_score, v2_score, @match_tolerance)

        Logger.info("[다윈V2 섀도우] #{title} — V1:#{v1_score} V2:#{v2_score} #{if matched, do: "일치", else: "불일치"}")

        record_shadow_run(%{
          paper_title: title,
          v1_score:    v1_score,
          v2_score:    v2_score,
          matched:     matched
        })

        maybe_notify_promotion()

      {:error, :selector_disabled} ->
        Logger.debug("[다윈V2 섀도우] V2 LLM 비활성 — 스킵")

      {:error, reason} ->
        Logger.warning("[다윈V2 섀도우] V2 평가 실패 (#{title}): #{inspect(reason)}")

        record_shadow_run(%{
          paper_title: title,
          v1_score:    v1_score,
          v2_score:    nil,
          matched:     false,
          error:       inspect(reason)
        })
    end
  end

  defp do_shadow_eval(_paper, _), do: :ok

  defp do_run_comparison(paper) do
    title  = paper["title"]  || paper[:title]  || "unknown"
    source = paper["source"] || paper[:source] || "unknown"
    v1_score = paper["score"] || paper[:score]

    prompt = build_eval_prompt(title, source)

    v2_result =
      case Darwin.V2.LLM.Selector.call_with_fallback(
             "darwin.evaluator",
             prompt,
             max_tokens: 256,
             task_type: :evaluation_scoring
           ) do
        {:ok, %{response: text}} -> {:ok, parse_score(text)}
        {:error, reason}         -> {:error, reason}
      end

    case v2_result do
      {:ok, v2_score} ->
        matched = is_number(v1_score) and ShadowCompare.score_match?(v1_score, v2_score, @match_tolerance)
        %{
          v1_score:    v1_score,
          v2_score:    v2_score,
          match:       matched,
          differences: if(matched, do: [], else: [{title, v1_score, v2_score}])
        }

      {:error, reason} ->
        %{v1_score: v1_score, v2_score: nil, match: false, error: inspect(reason)}
    end
  end

  # -------------------------------------------------------------------
  # Private — DB
  # -------------------------------------------------------------------

  defp record_shadow_run(data) do
    Repo.query(
      """
      INSERT INTO darwin_v2_shadow_runs
        (run_date, cycle_result, match_score, notes, inserted_at, updated_at)
      VALUES (CURRENT_DATE, $1, $2, $3, NOW(), NOW())
      """,
      [
        Jason.encode!(data),
        if(data[:matched], do: 1.0, else: 0.0),
        "v1=#{data[:v1_score]} v2=#{data[:v2_score]}"
      ]
    )
    |> case do
      {:ok, _}    -> :ok
      {:error, e} -> Logger.warning("[다윈V2 섀도우] DB 기록 실패: #{inspect(e)}")
    end
  rescue
    e -> Logger.warning("[다윈V2 섀도우] record_shadow_run 예외: #{Exception.message(e)}")
  end

  defp query_avg_match(days) do
    sql = """
    SELECT COALESCE(AVG(match_score)::float, 0.0)
    FROM darwin_v2_shadow_runs
    WHERE run_date >= CURRENT_DATE - ($1 || ' days')::interval
    """

    case Repo.query(sql, [to_string(days)]) do
      {:ok, %{rows: [[v]]}} when is_number(v) -> Float.round(v, 4)
      _                                        -> 0.0
    end
  rescue
    _ -> 0.0
  end

  defp build_summary do
    sql = """
    SELECT
      COUNT(*)                                    AS total_runs,
      COALESCE(AVG(match_score)::float,  0.0)    AS avg_match,
      COALESCE(MIN(match_score)::float,  0.0)    AS min_match,
      COUNT(DISTINCT run_date)                    AS distinct_days
    FROM darwin_v2_shadow_runs
    WHERE run_date >= CURRENT_DATE - INTERVAL '7 days'
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: [[total, avg, min_m, days]]}} ->
        %{
          total_runs:        total || 0,
          avg_match:         if(is_number(avg),   do: avg,   else: 0.0),
          min_match:         if(is_number(min_m), do: min_m, else: 0.0),
          promotion_ready:
            (total || 0) >= @promotion_min_runs and
            (days  || 0) >= @promotion_days     and
            (avg   || 0.0) >= @promotion_score
        }

      _ ->
        %{total_runs: 0, avg_match: 0.0, min_match: 0.0, promotion_ready: false}
    end
  rescue
    _ -> %{total_runs: 0, avg_match: 0.0, min_match: 0.0, promotion_ready: false}
  end

  defp check_promotion_ready do
    s = build_summary()
    s[:promotion_ready] == true
  end

  defp maybe_notify_promotion do
    s = build_summary()

    if s[:promotion_ready] do
      avg_pct = Float.round((s[:avg_match] || 0.0) * 100, 1)
      Logger.info("[다윈V2 섀도우] V2 승격 조건 달성 — match=#{avg_pct}%")

      Task.start(fn ->
        HubClient.post_alarm(
          "다윈팀 V2 Shadow 7일 완료 — match_rate #{avg_pct}%\n" <>
          "V2(Darwin.V2) 전환 승인 요청 (DARWIN_V2_ENABLED=true)",
          "darwin",
          "darwin_shadow"
        )
      end)
    end
  rescue
    _ -> :ok
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
      [_, s] -> s |> String.to_integer() |> min(10) |> max(0)
      _ ->
        case Regex.run(~r/(\d+)\s*\/\s*10/u, text) do
          [_, s] -> s |> String.to_integer() |> min(10) |> max(0)
          _      -> 5
        end
    end
  end
end
