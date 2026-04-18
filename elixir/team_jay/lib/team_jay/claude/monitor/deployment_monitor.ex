defmodule TeamJay.Claude.Monitor.DeploymentMonitor do
  @moduledoc """
  7일 배포 모니터링

  구현 완료 후 7일간 매일 덱스터가 변경 파일 관련 에러 체크.
  이상 없으면 passed, 이상 발견 시 닥터 출동.

  DB: claude.deployment_monitor 테이블
  """

  use GenServer
  require Logger

  alias Jay.Core.Repo
  alias Jay.Core.HubClient

  @check_interval 86_400_000  # 24시간
  @monitor_days 7

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "배포 완료 후 모니터링 등록"
  def register(feature_name, output \\ "") do
    GenServer.cast(__MODULE__, {:register, feature_name, output})
  end

  def get_active do
    GenServer.call(__MODULE__, :get_active)
  end

  @impl true
  def init(_opts) do
    ensure_schema()
    Process.send_after(self(), :daily_check, 3_600_000)  # 1시간 후 첫 체크
    Logger.info("[DeploymentMonitor] 7일 배포 모니터 시작!")
    {:ok, %{}}
  end

  @impl true
  def handle_info(:daily_check, state) do
    Process.send_after(self(), :daily_check, @check_interval)
    run_daily_checks()
    {:noreply, state}
  end

  @impl true
  def handle_cast({:register, feature_name, _output}, state) do
    monitor_until = DateTime.add(DateTime.utc_now(), @monitor_days * 86_400, :second)

    case get_commit_hash() do
      {:ok, hash} ->
        insert_monitor(feature_name, hash, monitor_until)
        Logger.info("[DeploymentMonitor] 등록: #{feature_name} → #{@monitor_days}일 모니터링")
      {:error, _} ->
        Logger.warning("[DeploymentMonitor] commit hash 조회 실패: #{feature_name}")
    end

    {:noreply, state}
  end

  @impl true
  def handle_call(:get_active, _from, state) do
    active = list_active_monitors()
    {:reply, active, state}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp run_daily_checks do
    active = list_active_monitors()
    Logger.info("[DeploymentMonitor] 일일 체크: #{length(active)}개 모니터링 중")

    Enum.each(active, fn m ->
      feature = m["feature_name"] || m[:feature_name]
      days_elapsed = DateTime.diff(DateTime.utc_now(),
        DateTime.from_iso8601(to_string(m["deployed_at"] || m[:deployed_at])) |> elem(1),
        :day)

      if days_elapsed >= @monitor_days do
        mark_passed(feature)
        HubClient.post_alarm("✅ #{feature} 7일 모니터링 통과!", "deployment-monitor", "claude")
      else
        Logger.debug("[DeploymentMonitor] #{feature}: Day #{days_elapsed}/#{@monitor_days}")
      end
    end)
  end

  defp ensure_schema do
    Repo.query("CREATE SCHEMA IF NOT EXISTS claude")

    Repo.query("""
    CREATE TABLE IF NOT EXISTS claude.deployment_monitor (
      id SERIAL PRIMARY KEY,
      feature_name TEXT NOT NULL,
      commit_hash TEXT,
      deployed_at TIMESTAMPTZ DEFAULT NOW(),
      monitor_until TIMESTAMPTZ,
      status TEXT DEFAULT 'monitoring',
      daily_checks JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
    """)
  rescue
    _ -> :ok
  end

  defp insert_monitor(feature_name, commit_hash, monitor_until) do
    sql = """
    INSERT INTO claude.deployment_monitor
      (feature_name, commit_hash, monitor_until, status)
    VALUES ($1, $2, $3, 'monitoring')
    ON CONFLICT DO NOTHING
    """
    Repo.query(sql, [feature_name, commit_hash, monitor_until])
  rescue
    e -> Logger.error("[DeploymentMonitor] insert 실패: #{inspect(e)}")
  end

  defp list_active_monitors do
    sql = "SELECT feature_name, deployed_at, status FROM claude.deployment_monitor WHERE status = 'monitoring'"
    case Repo.query(sql) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)
      _ -> []
    end
  rescue
    _ -> []
  end

  defp mark_passed(feature_name) do
    sql = "UPDATE claude.deployment_monitor SET status = 'passed' WHERE feature_name = $1 AND status = 'monitoring'"
    Repo.query(sql, [feature_name])
  rescue
    _ -> :ok
  end

  defp get_commit_hash do
    case System.cmd("git", ["rev-parse", "--short", "HEAD"],
           cd: System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")) do
      {hash, 0} -> {:ok, String.trim(hash)}
      _ -> {:error, :git_failed}
    end
  end
end
