defmodule TeamJay.Blog.TopicCurator do
  @moduledoc """
  D-1 포스팅 주제 사전 큐레이션 GenServer.

  매일 22:00 KST 실행:
    1. HN/GitHub/뉴스 이슈 수집 (Node.js 스크립트)
    2. 6개 카테고리 매칭 + LLM 후보 3건 생성
    3. blog.topic_candidates DB 저장
    4. Phase 1: 텔레그램 알림 (마스터 확인용)

  6개 카테고리 (순서 엄수):
    자기계발 / 성장과성공 / 홈페이지와APP / 최신IT트렌드 / IT정보와분석 / 개발기획과컨설팅

  연결:
    - topic-selector.ts: 당일 후보 조회 → 없으면 기존 풀 폴백
    - JayBus: :blog_content_planned 브로드캐스트
  """

  use GenServer
  require Logger
  alias TeamJay.Jay.Topics

  @curation_hour_utc 13
  @candidates_per_day 3    # 카테고리당 후보 수

  defstruct [
    last_curated_date: nil,
    last_curated_at: nil,
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 큐레이션 실행 (수동 트리거)"
  def curate_now do
    GenServer.cast(__MODULE__, :curate_now)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[TopicCurator] D-1 주제 큐레이션 서비스 시작")
    schedule_next_curation()
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast(:curate_now, state) do
    {:noreply, do_curate(state)}
  end

  @impl true
  def handle_info(:curate, state) do
    new_state = do_curate(state)
    schedule_next_curation()
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 큐레이션 실행 ────────────────────────────────────────

  defp do_curate(state) do
    today = Date.utc_today()
    already_today = state.last_curated_date == today

    if already_today do
      Logger.debug("[TopicCurator] 오늘 이미 큐레이션 완료 — 스킵")
      state
    else
      tomorrow = Date.add(today, 1)
      Logger.info("[TopicCurator] D-1 큐레이션 시작 → 대상일: #{tomorrow}")

      case run_curation_script(tomorrow) do
        {:ok, candidates} ->
          saved = save_candidates(candidates, tomorrow)
          broadcast_planned(candidates, tomorrow)
          notify_if_phase1(candidates, tomorrow)
          Logger.info("[TopicCurator] ✅ 큐레이션 완료 — #{saved}건 저장 (대상일: #{tomorrow})")
          %{state | last_curated_date: today, last_curated_at: DateTime.utc_now()}

        {:error, reason} ->
          Logger.warning("[TopicCurator] ❌ 큐레이션 실패: #{inspect(reason)}")
          state
      end
    end
  rescue
    e ->
      Logger.warning("[TopicCurator] do_curate 예외: #{inspect(e)}")
      state
  end

  # ─── Node.js 큐레이션 스크립트 ───────────────────────────

  defp run_curation_script(target_date) do
    date_str = Date.to_iso8601(target_date)
    script = "bots/blog/scripts/curate-daily-topics.ts --date=#{date_str} --count=#{@candidates_per_day} --json"

    case run_node_script(script) do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"ok" => true, "candidates" => candidates}} when is_list(candidates) ->
            {:ok, candidates}
          {:ok, %{"ok" => false, "error" => err}} ->
            {:error, err}
          {:ok, data} when is_list(data) ->
            {:ok, data}
          _ ->
            {:error, :parse_error}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp run_node_script(script) do
    project_root = Application.get_env(:team_jay, :project_root, "/Users/alexlee/projects/ai-agent-system")
    tsx = Path.join(project_root, "node_modules/.bin/tsx")
    [cmd | args] = String.split(script, " ")
    script_path = Path.join(project_root, cmd)

    case System.cmd(tsx, [script_path | args],
           cd: project_root,
           stderr_to_stdout: true,
           timeout: 120_000) do
      {output, 0} -> {:ok, String.trim(output)}
      {output, code} -> {:error, "exit #{code}: #{String.slice(output, 0, 300)}"}
    end
  rescue
    e -> {:error, inspect(e)}
  end

  # ─── DB 저장 ─────────────────────────────────────────────

  defp save_candidates(candidates, target_date) do
    date_str = Date.to_iso8601(target_date)

    Enum.reduce(candidates, 0, fn c, acc ->
      category  = c["category"] || "자기계발"
      title     = c["title"] || ""
      question  = c["question"] || ""
      diff      = c["diff"] || ""
      keywords  = c["keywords"] || []
      score     = c["score"] || 0.5
      keywords_pg = "{#{Enum.map(keywords, &~s("#{&1}")) |> Enum.join(",")}}"

      result = TeamJay.HubClient.pg_query("""
        INSERT INTO blog.topic_candidates
          (category, title, question, diff, keywords, score, status, target_date)
        VALUES (
          '#{escape(category)}',
          '#{escape(title)}',
          '#{escape(question)}',
          '#{escape(diff)}',
          '#{keywords_pg}',
          #{score},
          'pending',
          '#{date_str}'
        )
        ON CONFLICT DO NOTHING
      """, "blog")

      case result do
        {:ok, _} -> acc + 1
        _ -> acc
      end
    end)
  rescue
    e ->
      Logger.warning("[TopicCurator] save_candidates 예외: #{inspect(e)}")
      0
  end

  defp escape(str), do: String.replace(to_string(str), "'", "''")

  # ─── JayBus & 알림 ───────────────────────────────────────

  defp broadcast_planned(candidates, target_date) do
    Topics.broadcast(:blog_content_planned, %{
      date: target_date,
      candidates: candidates,
      count: length(candidates),
      curated_at: DateTime.utc_now()
    })
  rescue
    e -> Logger.warning("[TopicCurator] 브로드캐스트 실패: #{inspect(e)}")
  end

  defp notify_if_phase1(candidates, target_date) do
    # Phase 1: 마스터 확인을 위해 후보 알림
    summary =
      candidates
      |> Enum.take(3)
      |> Enum.with_index(1)
      |> Enum.map(fn {c, i} ->
        "[#{i}] #{c["category"]}: #{c["title"]}"
      end)
      |> Enum.join("\n")

    TeamJay.HubClient.post_alarm(
      "📋 [블로팀] #{target_date} 포스팅 후보 #{length(candidates)}건 준비됨\n#{summary}",
      "blog",
      "topic_curator"
    )
  rescue
    _ -> :ok
  end

  # ─── 스케줄링 ─────────────────────────────────────────────

  defp schedule_next_curation do
    now_utc = DateTime.utc_now()
    target_today = %{now_utc | hour: @curation_hour_utc, minute: 0, second: 0, microsecond: {0, 0}}

    ms_until =
      if DateTime.compare(now_utc, target_today) == :lt do
        DateTime.diff(target_today, now_utc, :millisecond)
      else
        # 내일 같은 시각
        tomorrow_target = DateTime.add(target_today, 86_400, :second)
        DateTime.diff(tomorrow_target, now_utc, :millisecond)
      end

    Logger.debug("[TopicCurator] 다음 큐레이션: #{div(ms_until, 60_000)}분 후")
    Process.send_after(self(), :curate, ms_until)
  end
end
