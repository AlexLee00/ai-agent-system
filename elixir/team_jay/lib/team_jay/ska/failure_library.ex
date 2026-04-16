defmodule TeamJay.Ska.FailureLibrary do
  @moduledoc """
  스카팀 실패 이력 대도서관 3계층 적재 GenServer.

  모든 실패/복구 이벤트를 대도서관(RAG)에 3계층으로 기록:
    L1 스키마: 실패 분류 메타 (타입, 날짜, 에이전트)
    L2 서머리: 실패 패턴 요약 (selectors diff, 에러 요약)
    L3 원본:   상세 에러 스택 + 셀렉터 변경 이력

  구독 토픽:
    :failure_reported  — 실패 → 에피소딕 기억 저장
    :failure_resolved  — 복구 성공 → 절차적 기억 저장
    :parsing_degraded  — 파싱 강등 → 에피소딕 기억 저장
    :selector_promoted — 셀렉터 승격 → 시맨틱 기억 저장
    :selector_deprecated — 셀렉터 폐기 → 시맨틱 기억 저장

  주 1회 episodic → semantic 통합 (LEARN 단계).
  """

  use GenServer
  require Logger

  alias TeamJay.Ska.PubSub, as: SkaPubSub

  @agent_id "ska.failure_library"
  @team "ska"
  @consolidate_interval_ms 7 * 24 * 60 * 60 * 1_000   # 주 1회

  defstruct [
    :ingested_count,
    :last_ingested_at
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "실패 이력을 대도서관에 직접 기록 (외부 호출용)"
  def ingest_failure(type, message, agent, metadata \\ %{}) do
    GenServer.cast(__MODULE__, {:ingest_failure, type, message, agent, metadata})
  end

  @doc "복구 이력을 대도서관에 직접 기록 (외부 호출용)"
  def ingest_recovery(type, strategy, agent, outcome, metadata \\ %{}) do
    GenServer.cast(__MODULE__, {:ingest_recovery, type, strategy, agent, outcome, metadata})
  end

  @doc "누적 통계 조회"
  def stats do
    GenServer.call(__MODULE__, :stats)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[FailureLibrary] 실패 이력 대도서관 시작")

    SkaPubSub.subscribe(:failure_reported)
    SkaPubSub.subscribe(:failure_resolved)
    SkaPubSub.subscribe(:parsing_degraded)
    SkaPubSub.subscribe(:selector_promoted)
    SkaPubSub.subscribe(:selector_deprecated)

    Process.send_after(self(), :consolidate, @consolidate_interval_ms)

    {:ok, %__MODULE__{ingested_count: 0, last_ingested_at: nil}}
  end

  @impl true
  def handle_call(:stats, _from, state) do
    {:reply, %{ingested_count: state.ingested_count, last_ingested_at: state.last_ingested_at}, state}
  end

  @impl true
  def handle_cast({:ingest_failure, type, message, agent, metadata}, state) do
    Task.start(fn -> store_failure(type, message, agent, metadata) end)
    {:noreply, bump(state)}
  end

  @impl true
  def handle_cast({:ingest_recovery, type, strategy, agent, outcome, metadata}, state) do
    Task.start(fn -> store_recovery(type, strategy, agent, outcome, metadata) end)
    {:noreply, bump(state)}
  end

  # ─── PubSub 핸들링 ───────────────────────────────────────

  @impl true
  def handle_info({:ska_event, :failure_reported, payload}, state) do
    type    = payload |> Map.get(:error_type, :unknown) |> to_string()
    message = Map.get(payload, :message, "")
    agent   = Map.get(payload, :agent, "unknown")
    target  = Map.get(payload, :target, "")

    Task.start(fn ->
      store_failure(type, message, agent, Map.put(payload, :target, target))
    end)

    {:noreply, bump(state)}
  end

  @impl true
  def handle_info({:ska_event, :failure_resolved, payload}, state) do
    failure_id = payload |> Map.get(:failure_id, "") |> to_string()
    strategy   = payload |> Map.get(:strategy, :unknown) |> to_string()

    Task.start(fn ->
      content = "복구 성공 | 실패ID: #{failure_id} | 전략: #{strategy}"
      remember("procedural", content, ["복구", strategy, "성공"], 0.8,
        Map.put(payload, :event, :failure_resolved))
    end)

    {:noreply, bump(state)}
  end

  @impl true
  def handle_info({:ska_event, :parsing_degraded, payload}, state) do
    target     = Map.get(payload, :target, "")
    from_level = Map.get(payload, :from_level, "") |> to_string()
    to_level   = Map.get(payload, :to_level, "")  |> to_string()

    Task.start(fn ->
      content = "파싱 성능 저하: #{target} — Level #{from_level} → Level #{to_level}"
      remember("episodic", content, ["파싱", "성능저하", target], 0.65,
        Map.put(payload, :event, :parsing_degraded))
    end)

    {:noreply, bump(state)}
  end

  @impl true
  def handle_info({:ska_event, :selector_promoted, payload}, state) do
    target      = Map.get(payload, :target, "")
    selector_id = payload |> Map.get(:selector_id, "") |> to_string()

    Task.start(fn ->
      content = "셀렉터 승격 (Promoted): #{target} / ID #{selector_id}"
      remember("semantic", content, ["셀렉터", "승격", target], 0.75,
        Map.put(payload, :event, :selector_promoted))
    end)

    {:noreply, bump(state)}
  end

  @impl true
  def handle_info({:ska_event, :selector_deprecated, payload}, state) do
    target      = Map.get(payload, :target, "")
    selector_id = payload |> Map.get(:selector_id, "") |> to_string()

    Task.start(fn ->
      content = "셀렉터 폐기 (Deprecated): #{target} / ID #{selector_id}"
      remember("semantic", content, ["셀렉터", "폐기", target], 0.70,
        Map.put(payload, :event, :selector_deprecated))
    end)

    {:noreply, bump(state)}
  end

  @impl true
  def handle_info(:consolidate, state) do
    Logger.info("[FailureLibrary] episodic → semantic 통합 시작")
    spawn(fn -> do_consolidate() end)
    Process.send_after(self(), :consolidate, @consolidate_interval_ms)
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── Private: 실패 저장 ──────────────────────────────────

  defp store_failure(type, message, agent, metadata) do
    content = "실패: #{type} | 에이전트: #{agent} | #{String.slice(message, 0, 200)}"
    keywords = ["실패", type, agent] |> Enum.reject(&(&1 == ""))
    remember("episodic", content, keywords, 0.70, Map.put(metadata, :event, :failure_reported))
  end

  defp store_recovery(type, strategy, agent, outcome, metadata) do
    content = "복구 #{outcome} | 유형: #{type} | 전략: #{strategy} | 에이전트: #{agent}"
    keywords = ["복구", type, strategy, agent, outcome] |> Enum.reject(&(&1 == ""))
    importance = if outcome == "success", do: 0.80, else: 0.65
    remember("procedural", content, keywords, importance, Map.put(metadata, :event, :recovery))
  end

  defp remember(memory_type, content, keywords, importance, metadata) do
    opts = %{keywords: keywords, importance: importance, metadata: metadata}
    case TeamJay.HubClient.memory_remember(@agent_id, @team, content, memory_type, opts) do
      {:ok, id} ->
        Logger.debug("[FailureLibrary] 기억 저장 OK (#{memory_type}): id=#{id}")
      {:error, reason} ->
        Logger.warning("[FailureLibrary] 기억 저장 실패 (#{memory_type}): #{inspect(reason)}")
    end
  rescue
    e -> Logger.warning("[FailureLibrary] remember 예외: #{inspect(e)}")
  end

  defp do_consolidate do
    # agent-memory.ts consolidate() 는 Hub /hub/memory/consolidate POST로 호출 예정.
    # HubClient에 consolidate 엔드포인트가 추가되면 여기서 호출한다.
    # 현재는 episodic 기억 자체가 충분히 축적되므로 로그만 남긴다.
    Logger.info("[FailureLibrary] episodic → semantic 통합 완료 (stub: consolidate 엔드포인트 미구현)")
  rescue
    e -> Logger.warning("[FailureLibrary] consolidate 예외: #{inspect(e)}")
  end

  defp bump(state) do
    %{state | ingested_count: state.ingested_count + 1, last_ingested_at: DateTime.utc_now()}
  end
end
