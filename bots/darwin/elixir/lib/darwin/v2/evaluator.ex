defmodule Darwin.V2.Evaluator do
  @moduledoc """
  다윈 V2 평가자 — 논문 적합성 LLM 평가 + ESPL 프롬프트 진화 통합.

  TeamJay.Darwin.Evaluator에서 진화:
    - V2 LLM 직접 호출 (Darwin.V2.LLM.Selector.complete/3)
    - ESPL 진화 프롬프트 사용 (Darwin.V2.ESPL.current_prompt/1)
    - 4차원 가중 평균 점수 (novelty/implementability/relevance/citation)
    - 고점수 패턴을 L1 메모리에 저장
    - score 결과 DB UPDATE
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, Lead, ESPL, Memory}

  @batch_size       5        # 5개 모이면 평가 실행
  @batch_wait_ms    60_000   # 또는 60초 대기
  @score_threshold  6        # 적용 후보 최소 점수
  @high_score_mem   7.5      # L1 메모리 저장 임계값

  # 4차원 가중치
  @weights %{
    novelty:          0.30,
    implementability: 0.30,
    relevance:        0.25,
    citation:         0.15
  }

  defstruct [
    queue: [],
    batch_timer: nil,
    evaluated_count: 0
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 평가 실행 (수동)"
  def evaluate_now do
    GenServer.cast(__MODULE__, :evaluate_now)
  end

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 2_000)
    Logger.info("[다윈V2 평가자] 시작!")
    {:ok, %__MODULE__{}}
  end

  # ── 이벤트 처리 ──────────────────────────────────────────────────────

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.paper_discovered(), [])
    Logger.debug("[다윈V2 평가자] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info(:batch_flush, state) do
    {:noreply, flush_batch(%{state | batch_timer: nil})}
  end

  def handle_info({:jay_event, topic, payload}, state)
      when topic == "darwin.paper.discovered" do
    paper = payload[:paper] || payload
    title = paper["title"] || paper[:title] || "unknown"
    Logger.debug("[다윈V2 평가자] 평가 큐 추가: #{title}")

    new_queue = [paper | state.queue]
    new_state = %{state | queue: new_queue}

    new_state =
      if length(new_queue) >= @batch_size do
        new_state |> cancel_timer() |> flush_batch()
      else
        schedule_batch_flush(new_state)
      end

    {:noreply, new_state}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast(:evaluate_now, state) do
    {:noreply, flush_batch(state)}
  end

  # ── 내부 ─────────────────────────────────────────────────────────────

  defp flush_batch(%{queue: []} = state) do
    check_unscored_papers()
    state
  end

  defp flush_batch(state) do
    batch = state.queue
    Logger.info("[다윈V2 평가자] 배치 평가 시작: #{length(batch)}건")

    Enum.each(batch, fn paper ->
      Task.start(fn -> evaluate_paper(paper) end)
    end)

    %{state |
      queue: [],
      evaluated_count: state.evaluated_count + length(batch)
    }
  end

  defp check_unscored_papers do
    sql = """
    SELECT id, title, url, summary, source, tags
    FROM reservation.rag_research
    WHERE score IS NULL
      AND created_at > NOW() - INTERVAL '24 hours'
    LIMIT 5
    """

    case Ecto.Adapters.SQL.query(TeamJay.Repo, sql, []) do
      {:ok, %{rows: rows, columns: cols}} when rows != [] ->
        Logger.info("[다윈V2 평가자] 미평가 논문 #{length(rows)}건 발견")
        Enum.each(rows, fn row ->
          paper = cols |> Enum.zip(row) |> Map.new()
          Task.start(fn -> evaluate_paper(paper) end)
        end)
      _ ->
        :ok
    end
  rescue
    _ -> :ok
  end

  defp evaluate_paper(paper) do
    title = paper["title"] || paper[:title] || "unknown"
    Logger.debug("[다윈V2 평가자] 평가 중: #{title}")

    # ESPL 프롬프트 (없으면 기본 프롬프트)
    system_prompt = ESPL.current_prompt("darwin.evaluator") || default_prompt()

    messages = [
      %{role: "user", content: build_evaluation_prompt(paper)}
    ]

    case Darwin.V2.LLM.Selector.complete("darwin.evaluator", messages,
           system: system_prompt,
           max_tokens: 512,
           task_type: :evaluation_scoring
         ) do
      {:ok, content} ->
        scores = parse_scores(content)
        final_score = calculate_weighted_score(scores)

        Logger.info("[다윈V2 평가자] #{title}: #{Float.round(final_score, 2)}점 " <>
          "(novelty=#{scores.novelty}, impl=#{scores.implementability}, " <>
          "rel=#{scores.relevance}, cite=#{scores.citation})")

        # DB 업데이트
        update_score_in_db(paper, final_score)

        # L1 메모리 — 고점수 패턴 저장
        if final_score >= @high_score_mem do
          Memory.store(
            {:evaluation_pattern, title},
            %{paper: paper, score: final_score, scores: scores},
            importance: final_score / 10.0
          )
        end

        # 브로드캐스트
        dispatch_result(paper, final_score)

      {:error, :kill_switch} ->
        Logger.warning("[다윈V2 평가자] Kill switch 발동 — #{title} 평가 건너뜀")

      {:error, reason} ->
        Logger.error("[다윈V2 평가자] LLM 호출 실패: #{inspect(reason)} (#{title})")
    end
  end

  defp build_evaluation_prompt(paper) do
    title    = paper["title"] || paper[:title] || ""
    summary  = paper["summary"] || paper[:summary] || ""
    tags     = paper["tags"] || paper[:tags] || []

    """
    다음 AI 연구 논문을 4가지 기준으로 0~10점 평가하세요.

    제목: #{title}
    요약: #{String.slice(to_string(summary), 0, 800)}
    태그: #{inspect(tags)}

    평가 기준:
    - novelty (신규성): 기존 연구 대비 새로운 아이디어/접근법 (0-10)
    - implementability (구현 가능성): 현재 시스템에 구현 가능한 정도 (0-10)
    - relevance (관련성): 팀 제이 시스템(자동화 에이전트/투자/블로그) 적용 가능성 (0-10)
    - citation_potential (인용 가능성): 연구 커뮤니티 파급력 (0-10)

    JSON 형식으로만 응답:
    {
      "novelty": 7,
      "implementability": 8,
      "relevance": 6,
      "citation_potential": 5,
      "reason": "한 줄 근거"
    }
    """
  end

  defp parse_scores(content) do
    cleaned =
      content
      |> String.replace(~r/```json\s*/i, "")
      |> String.replace(~r/```\s*/, "")
      |> String.trim()

    case Jason.decode(cleaned) do
      {:ok, parsed} ->
        %{
          novelty:          to_float(Map.get(parsed, "novelty", 5)),
          implementability: to_float(Map.get(parsed, "implementability", 5)),
          relevance:        to_float(Map.get(parsed, "relevance", 5)),
          citation:         to_float(Map.get(parsed, "citation_potential", 5))
        }

      {:error, _} ->
        # JSON 파싱 실패 시 기본값
        Logger.warning("[다윈V2 평가자] 점수 파싱 실패 — 기본값 사용")
        %{novelty: 5.0, implementability: 5.0, relevance: 5.0, citation: 5.0}
    end
  end

  defp calculate_weighted_score(scores) do
    @weights.novelty * scores.novelty +
    @weights.implementability * scores.implementability +
    @weights.relevance * scores.relevance +
    @weights.citation * scores.citation
  end

  defp update_score_in_db(paper, score) do
    paper_id = paper["id"] || paper[:id]

    if paper_id do
      sql = """
      UPDATE reservation.rag_research
      SET score = $1
      WHERE id = $2
      """

      case Ecto.Adapters.SQL.query(TeamJay.Repo, sql, [score, paper_id]) do
        {:ok, _} ->
          Logger.debug("[다윈V2 평가자] DB score 업데이트 완료: id=#{paper_id}")
        {:error, reason} ->
          Logger.warning("[다윈V2 평가자] DB 업데이트 실패: #{inspect(reason)}")
      end
    end
  rescue
    _ -> :ok
  end

  defp dispatch_result(paper, score) do
    if score >= @score_threshold do
      lead_paper = Map.put(paper, "score", score)
      Lead.paper_evaluated(lead_paper, score)
      broadcast(Topics.paper_evaluated(), %{paper: lead_paper, score: score})
    else
      broadcast(Topics.paper_rejected(), %{paper: paper, score: score})
    end
  end

  defp broadcast(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)

    Phoenix.PubSub.broadcast(Darwin.V2.PubSub, topic, payload)
  end

  defp schedule_batch_flush(state) do
    if state.batch_timer, do: Process.cancel_timer(state.batch_timer)
    timer = Process.send_after(self(), :batch_flush, @batch_wait_ms)
    %{state | batch_timer: timer}
  end

  defp cancel_timer(%{batch_timer: nil} = state), do: state
  defp cancel_timer(%{batch_timer: timer} = state) do
    Process.cancel_timer(timer)
    %{state | batch_timer: nil}
  end

  defp default_prompt do
    "당신은 AI 연구 논문 평가 전문가입니다. 논문의 신규성, 구현 가능성, 시스템 적용 관련성, 인용 가능성을 0~10점으로 평가하세요."
  end

  defp to_float(v) when is_float(v),   do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> 5.0
    end
  end
  defp to_float(_), do: 5.0
end
