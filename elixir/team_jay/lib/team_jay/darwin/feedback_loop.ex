defmodule TeamJay.Darwin.FeedbackLoop do
  @moduledoc """
  다윈팀 피드백 루프 — 7단계 연구 사이클 연속 실행

  DISCOVER → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN

  매일 06:00: DISCOVER (scanner.ts)
  매일 07:00: EVALUATE (evaluator.ts → 6점↑ 논문 선별)
  온디맨드: PLAN → IMPLEMENT → VERIFY → APPLY (L4↑에서 자동)
  매주: LEARN (결과 RAG 적재)
  """

  use GenServer
  require Logger

  alias TeamJay.Darwin.{TeamLead, Topics, Applier}

  defstruct [
    cycle_count: 0,
    last_cycle_at: nil,
    phase_history: []
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[DarwinLoop] 피드백 루프 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.paper_evaluated(), [])
    Registry.register(TeamJay.JayBus, Topics.verification_passed(), [])
    Logger.debug("[DarwinLoop] JayBus 구독 완료")
    {:noreply, state}
  end

  # EventLake 이벤트 기반 트리거
  def handle_info({:jay_event, topic, payload}, state) do
    cond do
      topic == Topics.paper_evaluated() ->
        score = get_in(payload, [:score]) || get_in(payload, ["score"]) || 0
        if score >= 6 do
          Logger.info("[DarwinLoop] 고적합 논문 → PLAN 단계")
          TeamLead.paper_evaluated(payload[:paper] || payload, score)
        end
        {:noreply, state}

      topic == Topics.verification_passed() ->
        paper = payload[:paper] || payload
        Logger.info("[DarwinLoop] 검증 통과 → APPLY 단계")
        level = TeamLead.get_autonomy_level()
        if level >= 4 do
          Logger.info("[DarwinLoop] L#{level}: 자동 적용!")
          Applier.apply_now(paper)
        else
          Logger.info("[DarwinLoop] L#{level}: 마스터 승인 필요")
        end
        {:noreply, update_phase(state, :apply)}

      true ->
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      cycle_count: state.cycle_count,
      last_cycle_at: state.last_cycle_at,
      recent_phases: Enum.take(state.phase_history, 10)
    }, state}
  end

  defp update_phase(state, phase) do
    history = [{phase, DateTime.utc_now()} | Enum.take(state.phase_history, 49)]
    %{state | phase_history: history, last_cycle_at: DateTime.utc_now()}
  end
end
