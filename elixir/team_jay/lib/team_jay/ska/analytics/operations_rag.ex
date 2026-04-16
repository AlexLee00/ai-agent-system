defmodule TeamJay.Ska.Analytics.OperationsRag do
  @moduledoc """
  스카팀 운영 이력 RAG 연동 모듈.

  SkaPubSub 이벤트를 구독해 운영 이력을 대도서관(rag.agent_memory)에 기록:
    - 실패 발생 → 에피소딕 기억 저장
    - 자동 복구 성공/실패 → 절차적 기억 저장
    - 파싱 성능 저하 → 에피소딕 기억 저장

  실패 복구 시 유사 과거 이력을 recall해 힌트 제공.
  매주 episodic → semantic 통합 (대도서관 학습 루프).
  """

  use GenServer
  require Logger

  alias TeamJay.Ska.PubSub, as: SkaPubSub

  @agent_id "ska.operations_rag"
  @team "ska"
  @consolidate_interval_ms 7 * 24 * 60 * 60 * 1_000  # 주 1회

  defstruct []

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "실패 이력 저장 (외부 직접 호출용)"
  def remember_failure(type, message, metadata \\ %{}) do
    GenServer.cast(__MODULE__, {:remember, :episodic, type, message, metadata})
  end

  @doc "복구 결과 저장 (외부 직접 호출용)"
  def remember_recovery(type, outcome, metadata \\ %{}) do
    content = "#{outcome} | 복구 타입: #{type}"
    GenServer.cast(__MODULE__, {:remember, :procedural, type, content, metadata})
  end

  @doc "유사 과거 실패 이력 조회"
  def recall_similar_failures(query, limit \\ 3) do
    GenServer.call(__MODULE__, {:recall, query, limit})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[OperationsRag] 스카 운영 이력 RAG 시작")

    # SkaPubSub 이벤트 구독
    SkaPubSub.subscribe(:failure_reported)
    SkaPubSub.subscribe(:parsing_degraded)
    SkaPubSub.subscribe(:phase_changed)

    # 주 1회 episodic → semantic 통합
    Process.send_after(self(), :consolidate, @consolidate_interval_ms)

    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast({:remember, type, event_type, content, metadata}, state) do
    store_memory(type, event_type, content, metadata)
    {:noreply, state}
  end

  @impl true
  def handle_call({:recall, query, limit}, _from, state) do
    result = do_recall(query, limit)
    {:reply, result, state}
  end

  # ─── PubSub 이벤트 핸들링 ─────────────────────────────────

  @impl true
  def handle_info({:ska_event, :failure_reported, payload}, state) do
    type = Map.get(payload, :type, :unknown)
    message = Map.get(payload, :message, "")
    target = Map.get(payload, :target, "")

    content = "실패: #{type} | 대상: #{target} | #{message}"
    keywords = ["실패", Atom.to_string(type), target] |> Enum.filter(&(&1 != ""))

    store_memory("episodic", Atom.to_string(type), content, %{
      event: :failure_reported,
      failure_type: type,
      target: target,
      original_metadata: payload
    }, keywords, 0.7)

    {:noreply, state}
  end

  @impl true
  def handle_info({:ska_event, :parsing_degraded, payload}, state) do
    target = Map.get(payload, :target, "")
    from_level = Map.get(payload, :from_level, "")
    to_level = Map.get(payload, :to_level, "")

    content = "파싱 성능 저하: #{target} — #{from_level} → #{to_level}"
    keywords = ["파싱", "성능저하", Atom.to_string(target)] |> Enum.filter(&(&1 != ""))

    store_memory("episodic", "parsing_degraded", content, %{
      event: :parsing_degraded,
      target: target
    }, keywords, 0.6)

    {:noreply, state}
  end

  @impl true
  def handle_info({:ska_event, :phase_changed, payload}, state) do
    from_phase = Map.get(payload, :from, "")
    to_phase = Map.get(payload, :to, "")

    content = "자율화 단계 변경: Phase #{from_phase} → Phase #{to_phase}"

    store_memory("semantic", "phase_changed", content, %{
      event: :phase_changed,
      from_phase: from_phase,
      to_phase: to_phase
    }, ["단계변경", "자율화"], 0.5)

    {:noreply, state}
  end

  @impl true
  def handle_info(:consolidate, state) do
    spawn(fn -> do_consolidate() end)
    Process.send_after(self(), :consolidate, @consolidate_interval_ms)
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── RAG 저장/조회 ────────────────────────────────────────

  defp store_memory(type, event_type, content, metadata, keywords \\ [], importance \\ 0.5) do
    opts = %{
      keywords: keywords,
      importance: importance,
      metadata: Map.merge(%{event_type: event_type}, metadata)
    }

    case TeamJay.HubClient.memory_remember(@agent_id, @team, content, type, opts) do
      {:ok, memory_id} ->
        Logger.debug("[OperationsRag] 기억 저장: #{event_type} → id=#{memory_id}")
      {:error, reason} ->
        Logger.warning("[OperationsRag] 기억 저장 실패 (#{event_type}): #{inspect(reason)}")
    end
  rescue
    e -> Logger.warning("[OperationsRag] store_memory 예외: #{inspect(e)}")
  end

  defp do_recall(query, limit) do
    opts = %{type: "episodic", limit: limit, threshold: 0.5}
    case TeamJay.HubClient.memory_recall(@agent_id, @team, query, opts) do
      {:ok, memories} -> memories
      {:error, _} -> []
    end
  rescue
    _ -> []
  end

  defp do_consolidate do
    Logger.info("[OperationsRag] episodic → semantic 통합 시작")
    # 통합은 현재 직접 구현 없이 기록만 (agent-memory.ts consolidate 호출 예정)
    # TODO: POST /hub/memory/consolidate 엔드포인트 추가 시 여기서 호출
    Logger.info("[OperationsRag] 통합 완료 (stub)")
  rescue
    e -> Logger.warning("[OperationsRag] 통합 예외: #{inspect(e)}")
  end
end
