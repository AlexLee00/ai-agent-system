defmodule TeamJay.Darwin.Evaluator do
  @moduledoc """
  다윈팀 이밸류에이터 — 논문 적합성 평가 오케스트레이터

  JayBus paper_discovered 수신 → 배치 큐 → research-evaluator.ts 트리거 → 결과 처리

  평가 흐름:
  1. paper_discovered 이벤트 수신 → 평가 큐에 추가
  2. 배치 완료 또는 즉시 평가 트리거
  3. rag_research.score 폴링 → score 확인
  4. 6점 이상 → TeamLead.paper_evaluated() + JayBus 브로드캐스트
  5. 6점 미만 → paper_rejected 브로드캐스트
  """

  use GenServer
  require Logger

  alias TeamJay.Repo
  alias TeamJay.Darwin.{TeamLead, Topics}
  alias TeamJay.Agents.PortAgent

  @batch_size    5       # 5개 모이면 평가 실행
  @batch_wait_ms 60_000  # 또는 1분 대기 후 실행
  @score_threshold 6     # 적용 후보 최소 점수

  defstruct [
    queue: [],
    batch_timer: nil,
    evaluated_count: 0
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 평가 실행"
  def evaluate_now do
    GenServer.cast(__MODULE__, :evaluate_now)
  end

  @impl true
  def init(_opts) do
    # JayBus 구독
    Process.send_after(self(), :subscribe_events, 2_000)
    Logger.info("[DarwinEvaluator] 이밸류에이터 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.paper_discovered(), [])
    Logger.debug("[DarwinEvaluator] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info(:batch_flush, state) do
    new_state = %{state | batch_timer: nil}
    {:noreply, flush_batch(new_state)}
  end

  def handle_info({:jay_event, topic, payload}, state) when topic == "darwin.paper.discovered" do
    paper = payload[:paper] || payload
    title = paper["title"] || paper[:title] || "unknown"
    Logger.debug("[DarwinEvaluator] 평가 큐 추가: #{title}")

    new_queue = [paper | state.queue]
    new_state = %{state | queue: new_queue}

    new_state =
      if length(new_queue) >= @batch_size do
        cancel_timer(new_state)
        flush_batch(new_state)
      else
        schedule_batch_flush(new_state)
      end

    {:noreply, new_state}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_cast(:evaluate_now, state) do
    {:noreply, flush_batch(state)}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp flush_batch(%{queue: []} = state) do
    # 큐가 비어있어도 rag_research에서 미평가 논문 체크
    check_unscored_papers()
    state
  end

  defp flush_batch(state) do
    count = length(state.queue)
    Logger.info("[DarwinEvaluator] 평가 배치 실행: #{count}건")

    if darwin_v2_llm_enabled?() do
      # Darwin.V2.LLM 인라인 평가 (Kill Switch ON 시)
      Task.start(fn -> evaluate_inline(state.queue) end)
    else
      # 기존 PortAgent 경로 (기본값)
      PortAgent.run(:darwin_evaluator)

      Task.start(fn ->
        :timer.sleep(30_000)
        process_evaluation_results()
      end)
    end

    %{state | queue: [], evaluated_count: state.evaluated_count + count}
  end

  defp evaluate_inline([]), do: :ok

  defp evaluate_inline(papers) do
    Logger.info("[DarwinEvaluator] Darwin.V2.LLM 인라인 평가 시작: #{length(papers)}건")

    Enum.each(papers, fn paper ->
      title  = paper["title"]  || paper[:title]  || "unknown"
      url    = paper["url"]    || paper[:url]     || ""
      source = paper["source"] || paper[:source]  || "unknown"

      prompt = """
      다음 논문이 AI 에이전트 시스템(루나/블로/스카/시그마/다윈팀)에 적합한지 평가해주세요.

      제목: #{title}
      출처: #{source}
      URL: #{url}

      요약: (1-2줄 한국어 요약)
      적합성: (0-10 숫자만)
      이유: (한 줄 이유)
      """

      case DarwinLLM.call_with_fallback("paper_evaluator", prompt, task_type: :binary_classification) do
        {:ok, %{response: text}} ->
          {score, summary} = parse_evaluation(text)
          Logger.info("[DarwinEvaluator] #{title} → #{score}점")

          Repo.query(
            """
            INSERT INTO rag_research (title, url, score, summary, source, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            ON CONFLICT (url) DO UPDATE SET score = $3, summary = $4, updated_at = NOW()
            """,
            [title, url, score, summary, source]
          )

          dispatch_evaluated_paper(%{"title" => title, "url" => url, "score" => score, "summary" => summary, "source" => source})

        {:error, reason} ->
          Logger.warning("[DarwinEvaluator] 인라인 평가 실패 (#{title}): #{inspect(reason)}, PortAgent 폴백")
          PortAgent.run(:darwin_evaluator)
      end
    end)
  end

  defp parse_evaluation(text) do
    score_match = Regex.run(~r/적합성:\s*(\d+(?:\.\d+)?)/u, text)
    summary_match = Regex.run(~r/요약:\s*(.+?)(?:\n|$)/u, text)

    score = case score_match do
      [_, s] -> s |> Float.parse() |> elem(0) |> round() |> min(10) |> max(0)
      _ -> 0
    end

    summary = case summary_match do
      [_, s] -> String.trim(s)
      _ -> "자동 평가됨"
    end

    {score, summary}
  end

  defp darwin_v2_llm_enabled? do
    System.get_env("DARWIN_V2_LLM_ENABLED", "false") == "true"
  end

  defp check_unscored_papers do
    case Repo.query("""
      SELECT title, url, score, summary, source
      FROM rag_research
      WHERE score IS NULL
        AND created_at > NOW() - INTERVAL '24 hours'
      LIMIT 5
    """, []) do
      {:ok, %{rows: rows}} when rows != [] ->
        Logger.info("[DarwinEvaluator] 미평가 논문 #{length(rows)}건 발견 → 평가 트리거")
        PortAgent.run(:darwin_evaluator)
      _ ->
        :ok
    end
  end

  defp process_evaluation_results do
    # 최근 평가 완료 논문 (score 있는 것) 처리
    case Repo.query("""
      SELECT title, url, score, summary, source, tags
      FROM rag_research
      WHERE score IS NOT NULL
        AND created_at > NOW() - INTERVAL '2 hours'
      ORDER BY score DESC, created_at DESC
      LIMIT 20
    """, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        papers = Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)
        Enum.each(papers, &dispatch_evaluated_paper/1)
      {:error, reason} ->
        Logger.warning("[DarwinEvaluator] 결과 조회 실패: #{inspect(reason)}")
    end
  end

  defp dispatch_evaluated_paper(paper) do
    score = paper["score"] || 0
    title = paper["title"] || "unknown"

    if score >= @score_threshold do
      Logger.info("[DarwinEvaluator] 고적합 논문 (#{score}점): #{title}")
      TeamLead.paper_evaluated(paper, score)
      broadcast(Topics.paper_evaluated(), %{paper: paper, score: score})
    else
      Logger.debug("[DarwinEvaluator] 저적합 논문 (#{score}점): #{title}")
      broadcast(Topics.paper_rejected(), %{paper: paper, score: score})
    end
  end

  defp broadcast(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)
  end

  defp schedule_batch_flush(state) do
    timer = Process.send_after(self(), :batch_flush, @batch_wait_ms)
    %{state | batch_timer: timer}
  end

  defp cancel_timer(%{batch_timer: nil} = state), do: state
  defp cancel_timer(%{batch_timer: timer} = state) do
    Process.cancel_timer(timer)
    %{state | batch_timer: nil}
  end
end
