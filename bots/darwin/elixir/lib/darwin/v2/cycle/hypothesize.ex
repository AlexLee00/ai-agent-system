defmodule Darwin.V2.Cycle.Hypothesize do
  @moduledoc """
  다윈 V2 Hypothesize 사이클 GenServer — 8단계 R&D 루프의 HYPOTHESIZE 단계.

  DISCOVER → **HYPOTHESIZE** → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN

  Sakana AI Scientist 패턴: 발견된 논문을 바탕으로 코드베이스에 적용 가능한
  검증 가능한 가설(Hypothesis)을 생성하고 DB에 저장한다.

  ## 핵심 기능
  - DISCOVER에서 등록된 논문을 받아 HypothesisEngine.generate/2 호출
  - 생성된 가설 ID를 페이로드에 추가하여 EVALUATE 단계로 전달
  - Kill Switch: DARWIN_HYPOTHESIS_ENGINE_ENABLED=true 시에만 활성
  - 비활성 시 논문을 그대로 EVALUATE로 패스스루

  Kill Switch: DARWIN_HYPOTHESIS_ENGINE_ENABLED=true
  """

  use GenServer
  require Logger

  alias Darwin.V2.HypothesisEngine
  alias Darwin.V2.Topics

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/cycle.hypothesize] Hypothesize 단계 기동")
    {:ok, %{runs: 0, hypotheses_generated: 0, last_run_at: nil}}
  end

  @doc "이 단계를 즉시 실행. payload에 :paper 필드 필요."
  def run_now(payload \\ %{}) do
    GenServer.cast(__MODULE__, {:run, payload})
  end

  @doc "현재 상태 조회."
  def status, do: GenServer.call(__MODULE__, :status)

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, Map.put(state, :phase, :hypothesize), state}
  end

  @impl GenServer
  def handle_cast({:run, payload}, state) do
    paper = Map.get(payload, :paper)
    new_state = do_hypothesize(paper, payload, state)
    {:noreply, new_state}
  end

  # ────────────────────────────────────────────────
  # Private
  # ────────────────────────────────────────────────

  defp do_hypothesize(nil, _payload, state) do
    Logger.debug("[darwin/cycle.hypothesize] paper 없음 — 건너뜀")
    %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}
  end

  defp do_hypothesize(paper, payload, state) do
    paper_id = paper[:paper_id] || paper["paper_id"] || paper[:id] || paper["id"] || ""
    paper_title = paper[:title] || paper["title"] || "unknown"

    {hypothesis_id, generated} =
      case HypothesisEngine.generate(paper) do
        {:ok, id} ->
          Logger.info("[darwin/cycle.hypothesize] 가설 생성 id=#{id} paper=#{String.slice(paper_title, 0, 50)}")
          {id, 1}

        {:skip, :disabled} ->
          Logger.debug("[darwin/cycle.hypothesize] HypothesisEngine 비활성 — 패스스루 paper_id=#{paper_id}")
          {nil, 0}

        {:error, reason} ->
          Logger.warning("[darwin/cycle.hypothesize] 가설 생성 실패 paper_id=#{paper_id}: #{inspect(reason)}")
          {nil, 0}
      end

    # EVALUATE 단계로 enriched payload 전달
    enriched = Map.put(payload, :hypothesis_id, hypothesis_id)
    broadcast_paper_hypothesized(paper, hypothesis_id, enriched)

    %{state |
      runs: state.runs + 1,
      hypotheses_generated: state.hypotheses_generated + generated,
      last_run_at: DateTime.utc_now()
    }
  end

  defp broadcast_paper_hypothesized(paper, hypothesis_id, payload) do
    topic = Topics.paper_hypothesized()
    full_payload = Map.merge(payload, %{
      paper: paper,
      hypothesis_id: hypothesis_id,
      hypothesized_at: DateTime.utc_now()
    })

    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, full_payload})
    end)
  end
end
