defmodule Darwin.V2.FeedbackLoop do
  @moduledoc """
  다윈 V2 피드백 루프 — 파이프라인 전 단계 피드백 기록 + 효과성 추적.

  TeamJay.Darwin.FeedbackLoop의 V2 포트. Memory.L1 통합 추가.

  역할:
  - 모든 파이프라인 피드백 기록 (paper_evaluated, verification_passed/failed, applied)
  - 논문별 효과성 추적 (성공/실패 비율)
  - ESPL 프롬프트 진화를 위한 효과성 데이터 제공
  - 중요 패턴을 Memory.L1 세션 메모리에 저장

  DB: darwin_v2_pipeline_audit
  GenServer: 모든 Darwin JayBus 토픽 구독
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, Memory}

  @check_interval_ms 10 * 60 * 1000  # 10분

  defstruct [
    total: 0,
    evaluated: 0,
    implemented: 0,
    verified: 0,
    applied: 0,
    recent_failures: []
  ]

  # ──────────────────────────────────────────────
  # 공개 API
  # ──────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "파이프라인 피드백 기록."
  @spec record_feedback(atom() | String.t(), map(), map()) :: :ok
  def record_feedback(event_type, payload, metadata \\ %{}) do
    GenServer.cast(__MODULE__, {:record_feedback, event_type, payload, metadata})
  end

  @doc "논문 URL별 효과성 조회."
  @spec get_effectiveness(String.t()) :: {integer(), integer(), float()}
  def get_effectiveness(paper_url) do
    GenServer.call(__MODULE__, {:get_effectiveness, paper_url})
  end

  @doc "파이프라인 전체 통계 조회."
  @spec pipeline_stats() :: map()
  def pipeline_stats do
    GenServer.call(__MODULE__, :pipeline_stats)
  end

  @doc "최근 실패 n건 조회."
  @spec recent_failures(non_neg_integer()) :: list(map())
  def recent_failures(n \\ 5) do
    GenServer.call(__MODULE__, {:recent_failures, n})
  end

  # ──────────────────────────────────────────────
  # GenServer 콜백
  # ──────────────────────────────────────────────

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Process.send_after(self(), :sync_stats, @check_interval_ms)
    Logger.info("[다윈V2 피드백루프] 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    topics = [
      Topics.paper_evaluated(),
      Topics.paper_rejected(),
      Topics.implementation_ready(),
      Topics.verification_passed(),
      Topics.verification_failed(),
      Topics.applied("darwin")
    ]

    Enum.each(topics, fn topic ->
      Registry.register(Jay.Core.JayBus, topic, [])
    end)

    Logger.debug("[다윈V2 피드백루프] JayBus 구독 완료 (#{length(topics)}개 토픽)")
    {:noreply, state}
  end

  def handle_info(:sync_stats, state) do
    new_state = sync_from_db(state)
    Process.send_after(self(), :sync_stats, @check_interval_ms)
    {:noreply, new_state}
  end

  def handle_info({:jay_event, topic, payload}, state) do
    new_state = handle_bus_event(topic, payload, state)
    {:noreply, new_state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast({:record_feedback, event_type, payload, metadata}, state) do
    Task.start(fn -> persist_audit(event_type, payload, metadata) end)
    new_state = update_counters(state, event_type, payload)
    {:noreply, new_state}
  end

  @impl GenServer
  def handle_call({:get_effectiveness, paper_url}, _from, state) do
    result = fetch_effectiveness(paper_url)
    {:reply, result, state}
  end

  def handle_call(:pipeline_stats, _from, state) do
    stats = %{
      total:       state.total,
      evaluated:   state.evaluated,
      implemented: state.implemented,
      verified:    state.verified,
      applied:     state.applied
    }
    {:reply, stats, state}
  end

  def handle_call({:recent_failures, n}, _from, state) do
    failures = Enum.take(state.recent_failures, n)
    {:reply, failures, state}
  end

  # ──────────────────────────────────────────────
  # 내부 — JayBus 이벤트 처리
  # ──────────────────────────────────────────────

  defp handle_bus_event(topic, payload, state) do
    cond do
      topic == Topics.paper_evaluated() ->
        score = get_field(payload, :score, get_field(payload, "score", 0))
        Logger.debug("[다윈V2 피드백루프] 논문 평가됨 (score=#{score})")
        record_feedback(:paper_evaluated, payload, %{topic: topic})
        update_counters(state, :paper_evaluated, payload)

      topic == Topics.paper_rejected() ->
        Logger.debug("[다윈V2 피드백루프] 논문 거절됨")
        record_feedback(:paper_rejected, payload, %{topic: topic})
        state

      topic == Topics.verification_passed() ->
        Logger.info("[다윈V2 피드백루프] 검증 통과")
        record_feedback(:verification_passed, payload, %{topic: topic})

        # 중요 패턴 → L1 세션 메모리 저장
        paper_title = get_field(payload, :title, get_field(payload, "title", "unknown"))
        Memory.store("last_verified_paper", %{title: paper_title, at: DateTime.utc_now()},
          importance: 0.8
        )

        update_counters(state, :verification_passed, payload)

      topic == Topics.verification_failed() ->
        reason = get_field(payload, :reason, get_field(payload, "reason", "unknown"))
        Logger.warning("[다윈V2 피드백루프] 검증 실패: #{inspect(reason)}")
        record_feedback(:verification_failed, payload, %{topic: topic, reason: reason})

        failure_entry = %{
          reason:      reason,
          paper_title: get_field(payload, :title, get_field(payload, "title", "unknown")),
          stage:       "verification"
        }

        new_failures = [failure_entry | Enum.take(state.recent_failures, 19)]
        %{state | recent_failures: new_failures}

      topic == Topics.applied("darwin") ->
        Logger.info("[다윈V2 피드백루프] 논문 적용 완료!")
        record_feedback(:applied, payload, %{topic: topic})

        # ESPL 효과성 피드백 트리거
        Task.start(fn -> notify_espl_success(payload) end)

        update_counters(state, :applied, payload)

      topic == Topics.implementation_ready() ->
        update_counters(state, :implementation_ready, payload)

      true ->
        state
    end
  end

  defp update_counters(state, event_type, _payload) do
    case event_type do
      :paper_evaluated     -> %{state | evaluated:   state.evaluated + 1,   total: state.total + 1}
      :implementation_ready -> %{state | implemented: state.implemented + 1}
      :verification_passed -> %{state | verified:    state.verified + 1}
      :applied             -> %{state | applied:     state.applied + 1}
      _                    -> state
    end
  end

  # ──────────────────────────────────────────────
  # 내부 — DB 지속성
  # ──────────────────────────────────────────────

  defp persist_audit(event_type, payload, metadata) do
    paper_url   = get_field(payload, :url,   get_field(payload, "url",   nil))
    paper_title = get_field(payload, :title, get_field(payload, "title", nil))
    score       = get_field(payload, :score, get_field(payload, "score", nil))
    stage       = to_string(event_type)
    meta_json   = Jason.encode!(metadata)

    sql = """
    INSERT INTO darwin_v2_pipeline_audit
      (paper_url, paper_title, stage, score, metadata, inserted_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
    ON CONFLICT DO NOTHING
    """

    case Jay.Core.Repo.query(sql, [paper_url, paper_title, stage, score, meta_json]) do
      {:ok, _} ->
        Logger.debug("[다윈V2 피드백루프] audit 저장 완료 (stage=#{stage})")

      {:error, reason} ->
        Logger.warning("[다윈V2 피드백루프] audit 저장 실패: #{inspect(reason)}")
    end
  rescue
    e -> Logger.warning("[다윈V2 피드백루프] persist_audit 예외: #{Exception.message(e)}")
  end

  defp fetch_effectiveness(paper_url) do
    sql = """
    SELECT
      COUNT(*) FILTER (WHERE stage = 'applied')::int         AS successes,
      COUNT(*) FILTER (WHERE stage = 'verification_failed')::int AS failures,
      COUNT(*)::int                                           AS total
    FROM darwin_v2_pipeline_audit
    WHERE paper_url = $1
    """

    case Jay.Core.Repo.query(sql, [paper_url]) do
      {:ok, %{rows: [[successes, failures, total]]}} when total > 0 ->
        rate = successes / max(total, 1)
        {successes, failures, Float.round(rate, 3)}

      _ ->
        {0, 0, 0.0}
    end
  rescue
    e ->
      Logger.warning("[다윈V2 피드백루프] effectiveness 조회 실패: #{Exception.message(e)}")
      {0, 0, 0.0}
  end

  defp sync_from_db(state) do
    sql = """
    SELECT
      COUNT(*)::int                                                    AS total,
      COUNT(*) FILTER (WHERE stage = 'paper_evaluated')::int          AS evaluated,
      COUNT(*) FILTER (WHERE stage = 'implementation_ready')::int     AS implemented,
      COUNT(*) FILTER (WHERE stage = 'verification_passed')::int      AS verified,
      COUNT(*) FILTER (WHERE stage = 'applied')::int                  AS applied
    FROM darwin_v2_pipeline_audit
    WHERE inserted_at >= NOW() - INTERVAL '24 hours'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[total, evaluated, implemented, verified, applied]]}} ->
        %{state |
          total:       total       || 0,
          evaluated:   evaluated   || 0,
          implemented: implemented || 0,
          verified:    verified    || 0,
          applied:     applied     || 0
        }

      _ ->
        state
    end
  rescue
    e ->
      Logger.warning("[다윈V2 피드백루프] DB 동기화 실패: #{Exception.message(e)}")
      state
  end

  defp notify_espl_success(payload) do
    agent_name = get_field(payload, :agent, get_field(payload, "agent", "darwin.evaluator"))

    sql = """
    UPDATE darwin_agent_prompts
    SET effectiveness = COALESCE(effectiveness, 0) + 1
    WHERE agent_name = $1 AND status = 'operational'
    """

    case Jay.Core.Repo.query(sql, [to_string(agent_name)]) do
      {:ok, _} ->
        Logger.debug("[다윈V2 피드백루프] ESPL 효과성 업데이트 완료 (agent=#{agent_name})")

      {:error, reason} ->
        Logger.debug("[다윈V2 피드백루프] ESPL 효과성 업데이트 실패: #{inspect(reason)}")
    end
  rescue
    _ -> :ok
  end

  defp get_field(map, key, default) when is_map(map) do
    Map.get(map, key, default)
  end

  defp get_field(_map, _key, default), do: default
end
