defmodule TeamJay.Blog.InsightsCollector do
  @moduledoc """
  매일 22:00 KST (13:00 UTC) 블로그 성과 자동 수집 GenServer.

  동작:
    1. 매일 13:00 UTC 실행 (이미 오늘 수집했으면 스킵)
    2. channel-insights-collector.ts --json --days=1 실행
    3. JSON 파싱 후 :blog_insights_collected 브로드캐스트
    4. 텔레그램 알림: 네이버 조회수, 참여율

  공개 API:
    - collect_now/0: 수동 트리거
  """

  use GenServer
  require Logger
  alias TeamJay.Jay.Topics

  @collection_hour_utc 13

  defstruct [
    last_collected_date: nil,
    last_collected_at: nil,
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 성과 수집 실행 (수동 트리거)"
  def collect_now do
    GenServer.cast(__MODULE__, :collect_now)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[InsightsCollector] 블로그 성과 수집 서비스 시작")
    schedule_next_collection()
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast(:collect_now, state) do
    {:noreply, do_collect(state)}
  end

  @impl true
  def handle_info(:collect, state) do
    new_state = do_collect(state)
    schedule_next_collection()
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 수집 실행 ────────────────────────────────────────────

  defp do_collect(state) do
    today = Date.utc_today()
    already_today = state.last_collected_date == today

    if already_today do
      Logger.debug("[InsightsCollector] 오늘 이미 수집 완료 — 스킵")
      state
    else
      Logger.info("[InsightsCollector] 성과 수집 시작 (#{today})")

      case run_node_script("bots/blog/scripts/channel-insights-collector.ts --json --days=1") do
        {:ok, output} ->
          case Jason.decode(output) do
            {:ok, result} ->
              broadcast_insights(result)
              notify_telegram(result)
              Logger.info("[InsightsCollector] ✅ 성과 수집 완료 (#{today})")
              %{state | last_collected_date: today, last_collected_at: DateTime.utc_now()}

            {:error, reason} ->
              Logger.warning("[InsightsCollector] JSON 파싱 실패: #{inspect(reason)}")
              state
          end

        {:error, reason} ->
          Logger.warning("[InsightsCollector] 스크립트 실행 실패: #{inspect(reason)}")
          state
      end
    end
  rescue
    e ->
      Logger.warning("[InsightsCollector] do_collect 예외: #{inspect(e)}")
      state
  end

  # ─── JayBus 브로드캐스트 ─────────────────────────────────

  defp broadcast_insights(result) do
    Topics.broadcast(:blog_insights_collected, %{
      snapshot_date: result["snapshotDate"],
      revenue_signal: result["revenueSignal"],
      channels: result["channels"] || [],
      collected_at: DateTime.utc_now()
    })
  rescue
    e -> Logger.warning("[InsightsCollector] 브로드캐스트 실패: #{inspect(e)}")
  end

  # ─── 텔레그램 알림 ───────────────────────────────────────

  defp notify_telegram(result) do
    channels = result["channels"] || []
    naver = Enum.find(channels, fn c -> c["channel"] == "naver_blog" end) || %{}
    views = naver["views"] || 0
    engagement = naver["engagementRate"] || 0.0

    Jay.Core.HubClient.post_alarm(
      "[블로팀] 성과 수집 완료: 네이버 조회수 #{views}, 참여율 #{engagement}%",
      "blog",
      "insights_collector"
    )
  rescue
    _ -> :ok
  end

  # ─── 스케줄링 ─────────────────────────────────────────────

  defp schedule_next_collection do
    now_utc = DateTime.utc_now()
    target_today = %{now_utc | hour: @collection_hour_utc, minute: 0, second: 0, microsecond: {0, 0}}

    ms_until =
      if DateTime.compare(now_utc, target_today) == :lt do
        DateTime.diff(target_today, now_utc, :millisecond)
      else
        tomorrow_target = DateTime.add(target_today, 86_400, :second)
        DateTime.diff(tomorrow_target, now_utc, :millisecond)
      end

    Logger.debug("[InsightsCollector] 다음 수집: #{div(ms_until, 60_000)}분 후")
    Process.send_after(self(), :collect, ms_until)
  end

  # ─── Node.js 스크립트 실행 ───────────────────────────────

  defp run_node_script(script) do
    project_root = Application.get_env(:team_jay, :project_root, "/Users/alexlee/projects/ai-agent-system")
    tsx = Path.join(project_root, "node_modules/.bin/tsx")
    [cmd | args] = String.split(script, " ")
    script_path = Path.join(project_root, cmd)
    timeout_ms = 120_000

    task =
      Task.async(fn ->
        System.cmd(tsx, [script_path | args],
          cd: project_root,
          stderr_to_stdout: true
        )
      end)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, {output, 0}} ->
        {:ok, String.trim(output)}

      {:ok, {output, code}} ->
        {:error, "exit #{code}: #{String.slice(output, 0, 300)}"}

      nil ->
        {:error, "command_timeout after #{timeout_ms}ms"}
    end
  rescue
    e -> {:error, inspect(e)}
  end
end
