defmodule Mix.Tasks.Phase3.Daemon.Cutover do
  use Mix.Task

  @shortdoc "Phase3 daemon 후보의 컷오버 드라이런을 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  상시 서비스(daemon) 후보의 launchd/PortAgent/health 상태를 한 번에 점검하고
  안전한 컷오버 순서를 dry-run으로 출력한다.

  `--execute`를 주면 실제로 짧은 컷오버를 시도한다.
  실패하면 launchd restore까지 자동으로 수행한다.

  ## Examples

      mix phase3.daemon.cutover --service hub_resource_api
      mix phase3.daemon.cutover --service blog_node_server --json
      mix phase3.daemon.cutover --service hub_resource_api --execute
  """

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args,
        strict: [service: :string, json: :boolean, execute: :boolean, timeout_ms: :integer]
      )

    service =
      opts
      |> Keyword.get(:service)
      |> parse_service!()

    report = TeamJay.Diagnostics.shadow_report()
    candidate = find_candidate!(report, service)
    port_agent = get_port_agent_status(service)
    launchd = get_launchd_status(candidate.label)
    health = probe_health(Map.get(candidate, :health_url))

    result = %{
      generated_at: DateTime.utc_now(),
      service: service,
      team: candidate.team,
      label: candidate.label,
      pilot_mode: Map.get(candidate, :pilot_mode),
      health_url: Map.get(candidate, :health_url),
      launchd: launchd,
      port_agent: port_agent,
      health_probe: health,
      cutover_ready?: cutover_ready?(candidate, launchd, port_agent, health),
      recommended_steps: build_steps(candidate)
    }

    final_result =
      if Keyword.get(opts, :execute, false) do
        execute_cutover(result, candidate, Keyword.get(opts, :timeout_ms, 10_000))
      else
        Map.put(result, :mode, :dry_run)
      end

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode_to_iodata!(final_result, pretty: true))
    else
      Mix.shell().info(render_text(final_result))
    end
  end

  defp parse_service!(nil) do
    Mix.raise("`--service`가 필요합니다. 예: mix phase3.daemon.cutover --service hub_resource_api")
  end

  defp parse_service!(value) when is_binary(value), do: String.to_existing_atom(value)

  defp find_candidate!(report, service) do
    (Map.get(report, :week2_shadow_agents, []) ++ Map.get(report, :week3_shadow_agents, []))
    |> Enum.find(&(Map.get(&1, :name) == service))
    |> case do
      nil ->
        Mix.raise("#{service}는 daemon cutover shadow 후보로 등록되어 있지 않습니다")

      %{pilot_mode: :daemon_cutover} = candidate ->
        candidate

      _candidate ->
        Mix.raise("#{service}는 현재 daemon_cutover 후보가 아닙니다")
    end
  end

  defp get_port_agent_status(service) do
    case GenServer.whereis(TeamJay.Agents.PortAgent.via(service)) do
      nil ->
        %{registered?: false, status: :missing}

      _pid ->
        state = TeamJay.Agents.PortAgent.get_status(service)

        %{
          registered?: true,
          status: Map.get(state, :status),
          schedule: Map.get(state, :schedule),
          runs: Map.get(state, :runs),
          last_run: Map.get(state, :last_run)
        }
    end
  rescue
    error ->
      %{registered?: false, status: :error, reason: Exception.message(error)}
  end

  defp get_launchd_status(nil), do: %{status: :missing, detail: "label 없음"}

  defp get_launchd_status(label) do
    case System.cmd("launchctl", ["list", label], stderr_to_stdout: true) do
      {output, 0} ->
        %{
          status: :loaded,
          label: label,
          pid: parse_launchctl_field(output, ~r/"pid"\s*=\s*(\d+)|"PID"\s*=\s*(\d+)/),
          last_exit_code:
            parse_launchctl_field(
              output,
              ~r/"last exit code"\s*=\s*(\d+)|"LastExitStatus"\s*=\s*(\d+)/
            ),
          detail: String.trim(output)
        }

      {output, _code} ->
        %{
          status: :missing,
          label: label,
          detail: String.trim(output)
        }
    end
  end

  defp parse_launchctl_field(output, regex) do
    case Regex.run(regex, output) do
      [_, value] when is_binary(value) and value != "" -> String.to_integer(value)
      [_, _, value] when is_binary(value) and value != "" -> String.to_integer(value)
      _ -> nil
    end
  end

  defp probe_health(nil), do: %{status: :skipped, detail: "health_url 없음"}

  defp probe_health(url) do
    case Req.get(url) do
      {:ok, %{status: 200, body: body}} ->
        %{status: :ok, http_status: 200, sample: summarize_body(body)}

      {:ok, %{status: status, body: body}} ->
        %{status: :error, http_status: status, sample: summarize_body(body)}

      {:error, error} ->
        %{status: :error, detail: Exception.message(error)}
    end
  end

  defp summarize_body(body) when is_binary(body), do: String.slice(body, 0, 200)
  defp summarize_body(body), do: inspect(body, limit: 20, printable_limit: 200)

  defp cutover_ready?(candidate, launchd, port_agent, health) do
    Map.get(candidate, :pilot_mode) == :daemon_cutover and
      Map.get(launchd, :status) == :loaded and
      Map.get(port_agent, :registered?) == true and
      Map.get(health, :status) == :ok
  end

  defp build_steps(candidate) do
    health_url = Map.get(candidate, :health_url, "health URL")

    [
      "launchd owner #{candidate.label}의 최근 로그와 상태를 확인",
      "Elixir PortAgent slot이 registered 상태인지 확인",
      "#{health_url} 응답이 200으로 안정적인지 확인",
      "짧은 전환 창에서 launchd stop -> PortAgent 수동 run -> #{health_url} 재확인",
      "문제 시 launchd restore를 바로 수행"
    ]
  end

  defp execute_cutover(result, candidate, timeout_ms) do
    if not result.cutover_ready? do
      Map.merge(result, %{
        mode: :execute,
        cutover_executed?: false,
        cutover_status: :blocked,
        cutover_reason: "사전 조건이 충족되지 않아 execute를 진행하지 않았습니다"
      })
    else
      label = candidate.label
      plist_path = plist_path_for!(label)
      domain_target = "gui/#{macos_uid()}/#{label}"

      case System.cmd("launchctl", ["bootout", domain_target], stderr_to_stdout: true) do
        {bootout_output, 0} ->
          launchd_after_bootout = wait_for_launchd_unloaded(label, timeout_ms)

          if launchd_after_bootout.status != :missing do
            Map.merge(result, %{
              mode: :execute,
              cutover_executed?: false,
              cutover_status: :bootout_incomplete,
              cutover_reason: "launchd bootout 이후에도 서비스가 계속 loaded 상태입니다",
              cutover_launchd_bootout: String.trim(bootout_output),
              launchd_after_bootout: launchd_after_bootout
            })
          else
            TeamJay.Agents.PortAgent.run(candidate.name)
            Process.sleep(1_500)
            health = wait_for_health(candidate.health_url, timeout_ms)
            launchd_after_cutover = get_launchd_status(label)

            if health.status == :ok and launchd_after_cutover.status == :missing do
              Map.merge(result, %{
                mode: :execute,
                cutover_executed?: true,
                cutover_status: :ok,
                cutover_reason: "launchd stop 후 PortAgent run과 health 확인까지 성공",
                cutover_launchd_bootout: String.trim(bootout_output),
                launchd_after_bootout: launchd_after_bootout,
                launchd_after_cutover: launchd_after_cutover,
                health_probe: health
              })
            else
              rollback = rollback_launchd(candidate.name, plist_path)

              cutover_reason =
                cond do
                  health.status != :ok ->
                    "PortAgent health 확인 실패로 launchd restore 수행"

                  launchd_after_cutover.status != :missing ->
                    "PortAgent run 이후에도 launchd owner가 남아 있어 launchd restore 수행"

                  true ->
                    "PortAgent cutover 확인 실패로 launchd restore 수행"
                end

              Map.merge(result, %{
                mode: :execute,
                cutover_executed?: true,
                cutover_status: :rolled_back,
                cutover_reason: cutover_reason,
                cutover_launchd_bootout: String.trim(bootout_output),
                launchd_after_bootout: launchd_after_bootout,
                launchd_after_cutover: launchd_after_cutover,
                health_probe: health,
                rollback: rollback
              })
            end
          end

        {bootout_output, _code} ->
          Map.merge(result, %{
            mode: :execute,
            cutover_executed?: false,
            cutover_status: :bootout_failed,
            cutover_reason: String.trim(bootout_output)
          })
      end
    end
  end

  defp wait_for_health(url, timeout_ms) do
    started_at = System.monotonic_time(:millisecond)
    do_wait_for_health(url, timeout_ms, started_at)
  end

  defp wait_for_launchd_unloaded(label, timeout_ms) do
    started_at = System.monotonic_time(:millisecond)
    do_wait_for_launchd_unloaded(label, timeout_ms, started_at)
  end

  defp do_wait_for_health(url, timeout_ms, started_at) do
    health = probe_health(url)

    cond do
      health.status == :ok ->
        health

      System.monotonic_time(:millisecond) - started_at >= timeout_ms ->
        health

      true ->
        Process.sleep(500)
        do_wait_for_health(url, timeout_ms, started_at)
    end
  end

  defp do_wait_for_launchd_unloaded(label, timeout_ms, started_at) do
    launchd = get_launchd_status(label)

    cond do
      launchd.status == :missing ->
        launchd

      System.monotonic_time(:millisecond) - started_at >= timeout_ms ->
        launchd

      true ->
        Process.sleep(500)
        do_wait_for_launchd_unloaded(label, timeout_ms, started_at)
    end
  end

  defp rollback_launchd(service, plist_path) do
    TeamJay.Agents.PortAgent.stop(service)
    Process.sleep(500)

    case System.cmd("launchctl", ["load", plist_path], stderr_to_stdout: true) do
      {output, 0} ->
        %{status: :ok, detail: String.trim(output)}

      {output, _code} ->
        %{status: :error, detail: String.trim(output)}
    end
  end

  defp macos_uid do
    System.cmd("id", ["-u"])
    |> elem(0)
    |> String.trim()
  end

  defp plist_path_for!("ai.hub.resource-api"),
    do: TeamJay.Config.repo_root() <> "/bots/hub/launchd/ai.hub.resource-api.plist"

  defp plist_path_for!("ai.blog.node-server"),
    do: TeamJay.Config.repo_root() <> "/bots/blog/launchd/ai.blog.node-server.plist"

  defp plist_path_for!("ai.worker.web"),
    do: TeamJay.Config.repo_root() <> "/bots/worker/launchd/ai.worker.web.plist"

  defp plist_path_for!("ai.worker.nextjs"),
    do: TeamJay.Config.repo_root() <> "/bots/worker/launchd/ai.worker.nextjs.plist"

  defp plist_path_for!(label), do: Mix.raise("plist 경로 매핑이 없습니다: #{label}")

  defp render_text(result) do
    """
    Phase3 Daemon Cutover #{if(result[:mode] == :execute, do: "Execute", else: "Dry Run")}
    generated_at: #{DateTime.to_iso8601(result.generated_at)}

    service: #{result.service}
    team: #{result.team}
    label: #{result.label}
    pilot_mode: #{result.pilot_mode}
    health_url: #{result.health_url}
    cutover_ready?: #{if(result.cutover_ready?, do: "yes", else: "no")}

    launchd.status=#{result.launchd.status}
    launchd.pid=#{Map.get(result.launchd, :pid)}
    launchd.last_exit_code=#{Map.get(result.launchd, :last_exit_code)}

    port_agent.registered?=#{result.port_agent.registered?}
    port_agent.status=#{result.port_agent.status}
    port_agent.runs=#{Map.get(result.port_agent, :runs)}
    port_agent.last_run=#{format_last_run(Map.get(result.port_agent, :last_run))}

    health_probe.status=#{result.health_probe.status}
    health_probe.http_status=#{Map.get(result.health_probe, :http_status)}
    health_probe.detail=#{Map.get(result.health_probe, :detail)}
    health_probe.sample=#{Map.get(result.health_probe, :sample)}

    cutover_status=#{Map.get(result, :cutover_status)}
    cutover_reason=#{Map.get(result, :cutover_reason)}

    steps:
    #{Enum.with_index(result.recommended_steps, 1) |> Enum.map_join("\n", fn {step, idx} -> "#{idx}. #{step}" end)}
    """
    |> String.trim()
  end

  defp format_last_run(nil), do: "-"
  defp format_last_run(%DateTime{} = datetime), do: DateTime.to_iso8601(datetime)
  defp format_last_run(value), do: inspect(value)
end
