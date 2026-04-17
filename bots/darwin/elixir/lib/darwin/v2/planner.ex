defmodule Darwin.V2.Planner do
  @moduledoc """
  다윈 V2 플래너 — EVALUATE → IMPLEMENT 연결 코디네이터 (V1 신규).

  paper_evaluated 이벤트 수신 (score >= 7) → 구현 계획 수립:
    1. Principle 체크 (plan_implementation)
    2. ResourceAnalyst 스킬로 자원 분석
    3. L2 메모리에서 유사 과거 논문 조회 (실패 이력 경고)
    4. darwin_implementation_plans DB 저장
    5. plan_ready 이벤트 브로드캐스트
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, AutonomyLevel, Memory}
  alias Darwin.V2.Principle.Loader, as: PrincipleLoader
  alias Darwin.V2.Skill.ResourceAnalyst
  alias TeamJay.HubClient

  @plan_score_threshold 7   # 계획 수립 최소 점수
  @plans_table "darwin_implementation_plans"

  defstruct [
    pending_plans: [],
    plan_count: 0
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "특정 논문에 대한 계획 수립 (수동)"
  def plan_for(paper) do
    GenServer.cast(__MODULE__, {:plan_for, paper})
  end

  @doc "대기 중인 계획 목록 반환"
  def get_pending_plans do
    GenServer.call(__MODULE__, :get_pending_plans)
  end

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 2_000)
    Logger.info("[다윈V2 플래너] 시작!")
    {:ok, %__MODULE__{}}
  end

  # ── 이벤트 처리 ──────────────────────────────────────────────────────

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.paper_evaluated(), [])
    Logger.debug("[다윈V2 플래너] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state)
      when topic == "darwin.paper.evaluated" do
    score = payload[:score] || payload["score"] || 0
    paper = payload[:paper] || payload

    new_state =
      if to_float(score) >= @plan_score_threshold do
        start_planning(paper, to_float(score), state)
      else
        state
      end

    {:noreply, new_state}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast({:plan_for, paper}, state) do
    {:noreply, start_planning(paper, @plan_score_threshold * 1.0, state)}
  end

  @impl GenServer
  def handle_call(:get_pending_plans, _from, state) do
    {:reply, state.pending_plans, state}
  end

  # ── 내부 ─────────────────────────────────────────────────────────────

  defp start_planning(paper, score, state) do
    title = paper["title"] || paper[:title] || "unknown"
    Logger.info("[다윈V2 플래너] 계획 수립 시작: #{title} (#{score}점)")

    Task.start(fn -> do_plan(paper, score) end)

    %{state |
      pending_plans: [paper | Enum.take(state.pending_plans, 9)],
      plan_count: state.plan_count + 1
    }
  end

  defp do_plan(paper, score) do
    title = paper["title"] || paper[:title] || "unknown"

    # 1. Principle 체크
    case PrincipleLoader.check("plan_implementation", %{paper: paper}) do
      {:blocked, violations} ->
        Logger.warning("[다윈V2 플래너] 원칙 위반으로 계획 차단: #{inspect(violations)}")
        notify_blocked(title, violations)
        :blocked

      {:approved, _} ->
        proceed_with_plan(paper, score)
    end
  rescue
    e ->
      title = paper["title"] || paper[:title] || "unknown"
      Logger.error("[다윈V2 플래너] 계획 수립 예외: #{inspect(e)} (#{title})")
  end

  defp proceed_with_plan(paper, score) do
    title = paper["title"] || paper[:title] || "unknown"

    # 2. ResourceAnalyst 스킬 실행
    resource_result =
      case ResourceAnalyst.run(%{paper: paper, max_cost_usd: 2.0}, %{}) do
        {:ok, result} -> result
        {:error, reason} ->
          Logger.warning("[다윈V2 플래너] 자원 분석 실패: #{inspect(reason)}")
          %{
            implementation_plan: ["기본 구현 계획"],
            resource_estimate: %{complexity: :medium, time_estimate_hours: 4},
            atomic_components: %{}
          }
      end

    # 3. L2 메모리에서 유사 논문 조회
    similar_memory = retrieve_similar_papers(title)
    failure_warning = build_failure_warning(similar_memory)

    # 4. 계획 구성
    plan = %{
      paper_id:            paper["id"] || paper[:id] || generate_paper_id(title),
      paper_title:         title,
      score:               score,
      implementation_steps: resource_result[:implementation_plan] || [],
      resource_estimate:   resource_result[:resource_estimate] || %{},
      atomic_components:   resource_result[:atomic_components] || %{},
      code_skeletons:      resource_result[:code_skeletons] || %{},
      failure_warning:     failure_warning,
      status:              "pending",
      created_at:          DateTime.utc_now()
    }

    # 5. DB 저장
    save_plan_to_db(plan)

    Logger.info("[다윈V2 플래너] 계획 완료: #{title} → #{length(plan.implementation_steps)}단계")

    # 6. plan_ready 브로드캐스트
    broadcast_plan_ready(paper, plan)
  end

  defp retrieve_similar_papers(title) do
    case Darwin.V2.Memory.L2.run(
           %{operation: :retrieve, content: title, team: "darwin", top_k: 3},
           %{}
         ) do
      {:ok, %{results: results}} -> results
      _ -> []
    end
  rescue
    _ -> []
  end

  defp build_failure_warning([]), do: nil

  defp build_failure_warning(similar_memory) do
    failures =
      similar_memory
      |> Enum.filter(fn m ->
        mem_type = m[:memory_type] || m["memory_type"] || ""
        to_string(mem_type) == "failure_lesson"
      end)

    if length(failures) > 0 do
      "경고: 유사 논문에서 과거 실패 이력 #{length(failures)}건 발견. " <>
      Enum.map_join(failures, "; ", fn f -> f[:content] || f["content"] || "" end)
      |> String.slice(0, 300)
    else
      nil
    end
  end

  defp save_plan_to_db(plan) do
    sql = """
    INSERT INTO #{@plans_table}
      (paper_id, paper_title, score, implementation_steps, resource_estimate,
       failure_warning, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (paper_id) DO UPDATE
      SET status = EXCLUDED.status,
          implementation_steps = EXCLUDED.implementation_steps,
          updated_at = NOW()
    """

    steps_json = Jason.encode!(plan.implementation_steps)
    resource_json = Jason.encode!(plan.resource_estimate)
    created_at = NaiveDateTime.utc_now()

    case Ecto.Adapters.SQL.query(TeamJay.Repo, sql, [
      plan.paper_id,
      plan.paper_title,
      plan.score,
      steps_json,
      resource_json,
      plan.failure_warning,
      plan.status,
      created_at
    ]) do
      {:ok, _} ->
        Logger.debug("[다윈V2 플래너] DB 저장 완료: #{plan.paper_title}")
      {:error, reason} ->
        Logger.warning("[다윈V2 플래너] DB 저장 실패: #{inspect(reason)}")
    end
  rescue
    e -> Logger.warning("[다윈V2 플래너] DB 저장 예외: #{inspect(e)}")
  end

  defp broadcast_plan_ready(paper, plan) do
    topic = Topics.plan_ready()
    payload = %{paper: paper, plan: plan}

    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)

    Phoenix.PubSub.broadcast(Darwin.V2.PubSub, topic, payload)
  end

  defp notify_blocked(title, violations) do
    Task.start(fn ->
      HubClient.post_alarm(
        "다윈팀 플래너 차단!\n논문: #{title}\n위반: #{Enum.join(violations, ", ")}",
        "darwin-planner-blocked", "darwin"
      )
    end)
  end

  defp generate_paper_id(title) do
    :crypto.hash(:md5, title) |> Base.encode16(case: :lower) |> String.slice(0, 16)
  end

  defp to_float(v) when is_float(v),   do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> 0.0
    end
  end
  defp to_float(_), do: 0.0
end
