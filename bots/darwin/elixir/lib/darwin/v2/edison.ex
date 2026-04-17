defmodule Darwin.V2.Edison do
  @moduledoc """
  다윈 V2 에디슨 — 자동 구현 에이전트.

  TeamJay.Darwin.Edison에서 진화:
    - plan_ready 이벤트 구독 (V1: paper_evaluated 직접 구독)
    - V2 LLM으로 코드 생성 (Planner의 implementation_plan 기반)
    - TreeSearch 스킬로 품질 < 7.0 시 대안 탐색
    - experimental/ 폴더에 구현 저장
    - darwin_implementation_plans 상태 업데이트

  자율 레벨별 동작:
    - L3: 마스터 승인 요청 (HubClient 알림)
    - L4+: 자동 구현 실행

  Kill switch 체크:
    - L3 + kill_switch → 승인 요청
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, AutonomyLevel, Lead}
  alias Darwin.V2.Skill.TreeSearch
  alias Jay.Core.HubClient

  @quality_threshold  7.0    # 이 미만이면 TreeSearch 트리거
  @experimental_base  "bots/darwin/experimental"

  defstruct [
    implementing: false,
    impl_count: 0,
    last_impl_at: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 구현 실행 (수동 트리거)"
  def implement_now(paper, plan \\ %{}) do
    GenServer.cast(__MODULE__, {:implement_now, paper, plan})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[다윈V2 에디슨] 시작!")
    {:ok, %__MODULE__{}}
  end

  # ── 이벤트 처리 ──────────────────────────────────────────────────────

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(Jay.Core.JayBus, Topics.plan_ready(), [])
    Logger.debug("[다윈V2 에디슨] JayBus 구독 완료 (plan_ready)")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state)
      when topic == "darwin.plan.ready" do
    paper = payload[:paper] || payload
    plan  = payload[:plan] || %{}
    {:noreply, handle_implement(paper, plan, state)}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast({:implement_now, paper, plan}, state) do
    {:noreply, handle_implement(paper, plan, state)}
  end

  @impl GenServer
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      implementing: state.implementing,
      impl_count: state.impl_count,
      last_impl_at: state.last_impl_at
    }, state}
  end

  # ── 내부 ─────────────────────────────────────────────────────────────

  defp handle_implement(paper, plan, state) do
    level      = AutonomyLevel.level()
    kill_sw    = Application.get_env(:darwin, :kill_switch, true)
    title      = paper["title"] || paper[:title] || "unknown"

    cond do
      level == 3 and kill_sw ->
        Logger.info("[다윈V2 에디슨] L3 + kill_switch: 마스터 승인 요청 (#{title})")
        request_impl_approval(paper, plan)
        state

      level >= 4 ->
        Logger.info("[다윈V2 에디슨] L#{level}: 자동 구현! #{title}")
        Task.start(fn -> do_implement(paper, plan) end)
        %{state |
          implementing: true,
          impl_count: state.impl_count + 1,
          last_impl_at: DateTime.utc_now()
        }

      true ->
        Logger.info("[다윈V2 에디슨] L#{level}: 마스터 승인 요청 (#{title})")
        request_impl_approval(paper, plan)
        state
    end
  end

  defp do_implement(paper, plan) do
    title    = paper["title"] || paper[:title] || "unknown"
    paper_id = paper["id"] || paper[:id] || generate_id(title)

    Logger.info("[다윈V2 에디슨] 구현 시작: #{title}")

    messages = build_implementation_messages(paper, plan)

    case Darwin.V2.LLM.Selector.complete("darwin.edison", messages,
           max_tokens: 4096,
           task_type: :code_generation
         ) do
      {:ok, code_content} ->
        quality = assess_code_quality(code_content, paper)

        # 품질 < 7.0: TreeSearch로 대안 탐색
        final_code =
          if quality < @quality_threshold do
            Logger.info("[다윈V2 에디슨] 품질 #{quality} < #{@quality_threshold} — TreeSearch 실행")
            apply_tree_search(paper, plan, code_content, quality)
          else
            code_content
          end

        # experimental/ 폴더 저장
        output_path = save_to_experimental(paper_id, title, final_code)

        # DB 업데이트 (rag_research + plans)
        update_implementation_db(paper, plan, final_code, output_path, quality)

        # implementation_ready 브로드캐스트
        broadcast_implementation_ready(paper, plan, final_code, output_path)

      {:error, :kill_switch} ->
        Logger.warning("[다윈V2 에디슨] Kill switch 발동 — #{title} 구현 건너뜀")

      {:error, reason} ->
        Logger.error("[다윈V2 에디슨] LLM 구현 실패: #{inspect(reason)} (#{title})")
        Lead.pipeline_failure("에디슨 구현 실패: #{title} (#{inspect(reason)})")
    end
  rescue
    e ->
      title = paper["title"] || paper[:title] || "unknown"
      Logger.error("[다윈V2 에디슨] 구현 예외: #{inspect(e)} (#{title})")
      Lead.pipeline_failure("에디슨 예외: #{title}")
  end

  defp build_implementation_messages(paper, plan) do
    title    = paper["title"] || paper[:title] || ""
    abstract = paper["summary"] || paper[:summary] || paper["abstract"] || ""
    steps    = plan[:implementation_steps] || plan["implementation_steps"] || []
    skeletons = plan[:code_skeletons] || plan["code_skeletons"] || %{}

    steps_text =
      steps
      |> List.flatten()
      |> Enum.map_join("\n", fn s -> "- #{s}" end)

    skeletons_text =
      if map_size(skeletons) > 0 do
        "코드 스켈레톤:\n" <>
        Enum.map_join(skeletons, "\n", fn {k, v} -> "### #{k}\n#{v}" end)
      else
        ""
      end

    [
      %{
        role: "user",
        content: """
        다음 AI 연구 논문의 핵심 알고리즘을 Python으로 구현하세요.

        논문 제목: #{title}
        요약: #{String.slice(to_string(abstract), 0, 600)}

        구현 단계:
        #{steps_text}

        #{skeletons_text}

        요구사항:
        - 완전히 실행 가능한 Python 코드 (import 포함)
        - 핵심 알고리즘에 집중, 보조 유틸리티 최소화
        - 코드 내 한국어 주석으로 각 단계 설명
        - 간단한 사용 예시 포함 (if __name__ == "__main__")
        - 의존성 목록 (requirements.txt 형식) 코드 상단에 주석으로 포함

        코드만 출력하세요 (마크다운 없이).
        """
      }
    ]
  end

  defp assess_code_quality(code_content, _paper) do
    # 간단한 휴리스틱 품질 평가
    base_score = 5.0
    penalties = []
    bonuses = []

    # 보너스: import 문 존재
    bonuses = if code_content =~ ~r/^import |^from /m, do: [1.5 | bonuses], else: bonuses
    # 보너스: 함수/클래스 정의
    bonuses = if code_content =~ ~r/^def |^class /m, do: [1.0 | bonuses], else: bonuses
    # 보너스: if __main__
    bonuses = if code_content =~ ~r/__main__/, do: [0.5 | bonuses], else: bonuses
    # 보너스: 주석
    bonuses = if code_content =~ ~r/#/, do: [0.5 | bonuses], else: bonuses
    # 페널티: 너무 짧음 (< 100 chars)
    penalties = if String.length(code_content) < 100, do: [3.0 | penalties], else: penalties
    # 페널티: TODO 과다
    todo_count = length(Regex.scan(~r/TODO/, code_content))
    penalties = if todo_count > 5, do: [1.0 | penalties], else: penalties

    score = base_score + Enum.sum(bonuses) - Enum.sum(penalties)
    max(0.0, min(10.0, score))
  end

  defp apply_tree_search(paper, plan, original_code, current_quality) do
    title = paper["title"] || paper[:title] || ""
    steps = plan[:implementation_steps] || plan["implementation_steps"] || []

    goal = """
    구현 목표: #{title}
    현재 품질: #{current_quality}/10
    개선 필요: #{@quality_threshold - current_quality}점 향상
    구현 단계: #{Enum.join(List.flatten(steps), ", ")}
    """

    params = %{
      implementation_goal: goal,
      paper_context: %{
        title: title,
        abstract: paper["summary"] || paper[:summary] || ""
      },
      max_depth: 2,
      max_width: 3,
      quality_threshold: @quality_threshold
    }

    case TreeSearch.run(params, %{}) do
      {:ok, %{best_path: [_ | _] = path, final_quality: q}} ->
        Logger.info("[다윈V2 에디슨] TreeSearch 완료: #{q}점")
        best_node = List.last(path)
        if q > current_quality and is_binary(best_node[:code_sketch]) do
          # TreeSearch가 더 좋은 코드 스켈레톤 찾은 경우 → LLM으로 완성
          refine_code_from_sketch(best_node[:code_sketch], paper)
        else
          original_code
        end

      _ ->
        Logger.info("[다윈V2 에디슨] TreeSearch 결과 없음 — 원본 사용")
        original_code
    end
  end

  defp refine_code_from_sketch(sketch, paper) do
    messages = [
      %{
        role: "user",
        content: """
        다음 코드 스켈레톤을 완전한 Python 구현으로 확장하세요.
        논문: #{paper["title"] || paper[:title] || ""}

        스켈레톤:
        #{sketch}

        완전한 실행 가능 코드로 확장하세요. 코드만 출력하세요.
        """
      }
    ]

    case Darwin.V2.LLM.Selector.complete("darwin.edison", messages, max_tokens: 2048) do
      {:ok, refined} -> refined
      _              -> sketch
    end
  end

  defp save_to_experimental(paper_id, title, code) do
    project_root = System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")
    dir = Path.join([project_root, @experimental_base, paper_id])

    File.mkdir_p!(dir)

    filename = title
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9]/, "_")
      |> String.slice(0, 40)

    path = Path.join(dir, "#{filename}.py")
    File.write!(path, code)

    Logger.info("[다윈V2 에디슨] 코드 저장: #{path}")
    path
  rescue
    e ->
      Logger.warning("[다윈V2 에디슨] 파일 저장 실패: #{inspect(e)}")
      nil
  end

  defp update_implementation_db(paper, plan, _code, path, quality) do
    title    = paper["title"] || paper[:title] || "unknown"
    paper_id = paper["id"] || paper[:id]

    # rag_research 업데이트
    if paper_id do
      summary = "품질 #{Float.round(quality, 1)}/10. 경로: #{path}"
      sql1 = """
      UPDATE reservation.rag_research
      SET implementation_status = 'done',
          implementation_summary = $1
      WHERE id = $2
      """
      Ecto.Adapters.SQL.query(Jay.Core.Repo, sql1, [summary, paper_id])
    end

    # darwin_implementation_plans 업데이트
    plan_paper_id = plan[:paper_id] || plan["paper_id"] || paper_id || generate_id(title)
    if plan_paper_id do
      sql2 = """
      UPDATE darwin_implementation_plans
      SET status = 'implemented', updated_at = NOW()
      WHERE paper_id = $1
      """
      Ecto.Adapters.SQL.query(Jay.Core.Repo, sql2, [plan_paper_id])
    end
  rescue
    _ -> :ok
  end

  defp broadcast_implementation_ready(paper, plan, code, path) do
    topic = Topics.implementation_ready()
    payload = %{
      paper: paper,
      plan: plan,
      implementation: %{
        code: String.slice(code, 0, 500) <> "…",
        path: path,
        timestamp: DateTime.utc_now()
      }
    }

    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)

    Phoenix.PubSub.broadcast(Darwin.V2.PubSub, topic, payload)

    title = paper["title"] || paper[:title] || "unknown"
    Task.start(fn ->
      HubClient.post_alarm(
        "다윈V2 에디슨 구현 완료!\n논문: #{title}\n경로: #{path}\n→ 검증 단계로 이동",
        "darwin-edison", "darwin"
      )
    end)

    Lead.pipeline_success()
  end

  defp request_impl_approval(paper, plan) do
    title = paper["title"] || paper[:title] || "unknown"
    score = plan[:score] || plan["score"] || paper["score"] || "?"

    Task.start(fn ->
      HubClient.post_alarm(
        "다윈V2 구현 승인 필요!\n논문: #{title}\n적합성: #{score}/10\n" <>
        "→ 승인: darwin_approve / 거부: darwin_reject",
        "darwin-impl-approval", "darwin"
      )
    end)
  end

  defp generate_id(title) do
    :crypto.hash(:md5, title) |> Base.encode16(case: :lower) |> String.slice(0, 16)
  end
end
