defmodule TeamJay.Blog.TokenRenewal do
  @moduledoc """
  인스타그램 Long-lived access token 자동 갱신 GenServer.

  동작:
    - 매일 09:00 KST (00:00 UTC) 만료 체크
    - 만료 7일 이내 → Hub를 통해 Node.js refresh-instagram-token 스크립트 실행
    - 성공/실패 → blog.token_renewal_log 기록
    - 갱신 성공 → :blog_token_renewed JayBus 브로드캐스트
    - 갱신 실패 → 텔레그램 CRITICAL 알림

  만료일: 2026-06-11 (현재 59.7일 남음, 자동 갱신 대상)
  """

  use GenServer
  require Logger
  alias Jay.V2.Topics

  @renew_threshold_days 7    # 만료 X일 이전부터 갱신 시도
  @check_interval_ms 24 * 60 * 60 * 1_000   # 24시간마다 체크
  @script_path "bots/blog/scripts/refresh-instagram-token.ts"

  defstruct [
    last_checked_at: nil,
    last_renewed_at: nil,
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 갱신 체크 (수동 트리거)"
  def check_now do
    GenServer.cast(__MODULE__, :check_now)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[TokenRenewal] 인스타그램 토큰 자동 갱신 서비스 시작")
    # 시작 후 5분 뒤 첫 체크 (Hub 초기화 대기)
    Process.send_after(self(), :check, 5 * 60 * 1_000)
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast(:check_now, state) do
    {:noreply, do_check(state)}
  end

  @impl true
  def handle_info(:check, state) do
    new_state = do_check(state)
    Process.send_after(self(), :check, @check_interval_ms)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 토큰 체크 & 갱신 ────────────────────────────────────

  defp do_check(state) do
    with {:ok, health} <- fetch_token_health() do
      days_left = health["daysLeft"]

      cond do
        days_left == nil ->
          log_missing_expiry_info(health)
          %{state | last_checked_at: DateTime.utc_now()}

        days_left <= 0 ->
          Logger.error("[TokenRenewal] ❌ 토큰 이미 만료! days_left=#{days_left}")
          send_critical_alert("인스타그램 토큰 이미 만료! 즉시 수동 갱신 필요")
          record_renewal_log("failed", days_left, nil, "token_already_expired")
          %{state | last_checked_at: DateTime.utc_now()}

        days_left <= @renew_threshold_days ->
          Logger.info("[TokenRenewal] 만료 #{days_left}일 남음 → 자동 갱신 시도")
          result = attempt_renewal(days_left)
          %{state | last_checked_at: DateTime.utc_now(), last_renewed_at: if(result == :ok, do: DateTime.utc_now(), else: state.last_renewed_at)}

        true ->
          Logger.debug("[TokenRenewal] 토큰 정상 (#{days_left}일 남음) — 갱신 불필요")
          %{state | last_checked_at: DateTime.utc_now()}
      end
    else
      {:error, reason} ->
        Logger.warning("[TokenRenewal] 토큰 헬스 조회 실패: #{inspect(reason)}")
        %{state | last_checked_at: DateTime.utc_now()}
    end
  rescue
    e ->
      Logger.warning("[TokenRenewal] do_check 예외: #{inspect(e)}")
      state
  end

  defp fetch_token_health do
    fetch_token_health_via_script()
  end

  defp fetch_token_health_via_script do
    case run_node_script("bots/blog/scripts/check-instagram-token-health.ts --json") do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, data} -> {:ok, data}
          _ -> {:error, :parse_error}
        end
      err -> err
    end
  end

  defp log_missing_expiry_info(health) do
    warning = Map.get(health, "warning")
    source = Map.get(health, "source")

    details =
      [source && "source=#{source}", warning && "warning=#{warning}"]
      |> Enum.filter(& &1)
      |> Enum.join(", ")

    suffix = if details == "", do: "", else: " (#{details})"

    Logger.info("[TokenRenewal] 토큰 만료일 정보 없음 — 갱신 시도 생략#{suffix}")
  end

  defp attempt_renewal(days_left) do
    case run_node_script("#{@script_path} --json") do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, %{"ok" => true} = result} ->
            new_expires = result["newExpiresAt"]
            Logger.info("[TokenRenewal] ✅ 갱신 성공! 새 만료일: #{new_expires}")
            record_renewal_log("success", days_left, new_expires, nil)
            broadcast_renewed(new_expires)
            :ok

          {:ok, %{"ok" => false, "error" => err}} ->
            Logger.error("[TokenRenewal] ❌ 갱신 실패: #{err}")
            record_renewal_log("failed", days_left, nil, err)
            send_critical_alert("인스타그램 토큰 자동 갱신 실패 (#{days_left}일 남음): #{err}")
            :error

          _ ->
            Logger.error("[TokenRenewal] ❌ 갱신 응답 파싱 실패: #{inspect(output)}")
            record_renewal_log("failed", days_left, nil, "parse_error")
            :error
        end

      {:error, reason} ->
        Logger.error("[TokenRenewal] ❌ 스크립트 실행 실패: #{inspect(reason)}")
        record_renewal_log("failed", days_left, nil, inspect(reason))
        send_critical_alert("인스타그램 토큰 갱신 스크립트 실패: #{inspect(reason)}")
        :error
    end
  end

  # ─── Node.js 스크립트 실행 ────────────────────────────────

  defp run_node_script(script) do
    project_root = Application.get_env(:team_jay, :project_root, "/Users/alexlee/projects/ai-agent-system")
    script_path = Path.join(project_root, script |> String.split(" ") |> hd())
    args = script |> String.split(" ") |> tl()
    {runner, runner_args} = resolve_script_runner(project_root)

    case System.cmd(runner, runner_args ++ [script_path | args],
           cd: project_root,
           stderr_to_stdout: true) do
      {output, 0} -> {:ok, String.trim(output)}
      {output, code} -> {:error, "exit #{code}: #{String.slice(output, 0, 200)}"}
    end
  rescue
    e -> {:error, inspect(e)}
  end

  defp resolve_script_runner(project_root) do
    tsx_candidates = [
      Path.join(project_root, "node_modules/.bin/tsx"),
      Path.join(project_root, "node_modules/tsx/dist/cli.cjs"),
      System.find_executable("tsx")
    ]

    case Enum.find(tsx_candidates, &(&1 && File.exists?(&1))) do
      nil ->
        node = System.find_executable("node") || "/opt/homebrew/bin/node"
        {node, []}

      tsx ->
        if String.ends_with?(tsx, ".cjs") do
          node = System.find_executable("node") || "/opt/homebrew/bin/node"
          {node, [tsx]}
        else
          {tsx, []}
        end
    end
  end

  # ─── JayBus & 알림 ───────────────────────────────────────

  defp broadcast_renewed(new_expires_at) do
    Topics.broadcast(:blog_token_renewed, %{
      provider: "instagram",
      new_expires_at: new_expires_at,
      renewed_at: DateTime.utc_now()
    })
  rescue
    e -> Logger.warning("[TokenRenewal] 브로드캐스트 실패: #{inspect(e)}")
  end

  defp send_critical_alert(message) do
    Jay.Core.HubClient.post_alarm(
      "[블로팀 CRITICAL] #{message}",
      "blog",
      "token_renewal"
    )
  rescue
    _ -> :ok
  end

  # ─── DB 로그 ─────────────────────────────────────────────

  defp record_renewal_log(result, days_left, new_expires_at, error_message) do
    expires_val = if new_expires_at, do: "'#{new_expires_at}'", else: "NULL"
    error_val   = if error_message, do: "'#{String.replace(error_message, "'", "''")}'", else: "NULL"

    Jay.Core.HubClient.pg_query("""
      INSERT INTO blog.token_renewal_log
        (provider, result, days_left, new_expires_at, error_message)
      VALUES ('instagram', '#{result}', #{days_left || "NULL"}, #{expires_val}, #{error_val})
    """, "blog")
  rescue
    _ -> :ok
  end
end
