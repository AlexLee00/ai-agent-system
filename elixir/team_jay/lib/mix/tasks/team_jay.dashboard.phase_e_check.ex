defmodule Mix.Tasks.TeamJay.Dashboard.PhaseECheck do
  @moduledoc """
  Phase E LiveView dashboard + Langfuse/Telegram bridge smoke.

  This check is static by design. It does not start Langfuse containers, call
  Telegram, restart protected runtimes, or mutate production data.
  """
  use Mix.Task

  @shortdoc "Checks TeamJay Phase E dashboard wiring"

  @impl true
  def run(args) do
    json? = "--json" in args
    repo_root = repo_root()

    dashboard_source = read!("lib/team_jay/dashboard/live/dashboard_live.ex")
    health_plug_source = read!("lib/team_jay/dashboard/health_plug.ex")
    event_lake_source = read!("../../packages/elixir_core/lib/jay/core/event_lake.ex")
    router_source = read!("lib/team_jay/dashboard/router.ex")
    controller_source = read!("lib/team_jay/dashboard/master_intervention_controller.ex")
    runtime_source = read!("config/runtime.exs")
    compose_source = read!(Path.join(repo_root, "docker/docker-compose.langfuse.yml"))
    env_example_source = read!(Path.join(repo_root, "docker/.env.langfuse.example"))
    route_registry_source = read!(Path.join(repo_root, "bots/hub/src/route-registry.ts"))
    poller_source = read!(Path.join(repo_root, "bots/hub/scripts/telegram-callback-poller.ts"))
    hub_autonomy_source = read!(Path.join(repo_root, "bots/hub/lib/routes/autonomy.ts"))

    checks = %{
      phase_e_header:
        String.contains?(dashboard_source, "Phase E • 영역 1+2+3+4+5+6+7+8 + Layer 1"),
      health_phase_e:
        String.contains?(health_plug_source, ~s(@dashboard_phase "E")) and
          String.contains?(health_plug_source, "Langfuse OTel + Telegram intervention bridge"),
      trace_column_rendered:
        String.contains?(dashboard_source, "langfuse_trace_url") and
          String.contains?(dashboard_source, "target=\"_blank\"") and
          String.contains?(dashboard_source, "short_trace_id"),
      event_lake_trace_context:
        String.contains?(event_lake_source, "current_span_ctx") and
          String.contains?(event_lake_source, "hex_span_ctx") and
          String.contains?(event_lake_source, "maybe_attach_current_trace_id"),
      team_jay_api_route:
        String.contains?(router_source, "/api") and
          String.contains?(router_source, "/master-intervention") and
          String.contains?(controller_source, "record_master_intervention"),
      team_jay_api_guard:
        String.contains?(controller_source, "TEAM_JAY_MASTER_INTERVENTION_TOKEN") and
          String.contains?(controller_source, "HUB_CONTROL_CALLBACK_SECRET"),
      langfuse_runtime_config:
        String.contains?(runtime_source, "LANGFUSE_HOST") and
          String.contains?(runtime_source, "LANGFUSE_OTEL_ENABLED") and
          String.contains?(runtime_source, "opentelemetry_exporter"),
      langfuse_compose_scaffold:
        String.contains?(compose_source, "langfuse-web") and
          String.contains?(compose_source, "langfuse-worker") and
          String.contains?(compose_source, "clickhouse") and
          String.contains?(compose_source, "minio-init"),
      langfuse_no_real_keys:
        not Regex.match?(
          ~r/(sk-lf-[A-Za-z0-9_-]{12,}|pk-lf-[A-Za-z0-9_-]{12,})/,
          env_example_source
        ),
      hub_autonomy_route:
        String.contains?(route_registry_source, "/hub/v2/autonomy/intervention") and
          String.contains?(hub_autonomy_source, "/api/master-intervention"),
      telegram_master_message_bridge:
        String.contains?(poller_source, "MASTER_TELEGRAM_CHAT_IDS") and
          String.contains?(poller_source, "allowed_updates: ['callback_query', 'message']") and
          String.contains?(poller_source, "forwardMasterMessage")
    }

    result = %{
      ok: Enum.all?(Map.values(checks)),
      dashboard_url: "http://localhost:#{dashboard_port()}",
      phase: "E",
      layer: "Langfuse OTel + Telegram intervention bridge",
      checks: checks
    }

    if json? do
      Mix.shell().info(Jason.encode!(result, pretty: true))
    else
      Enum.each(checks, fn {name, ok?} ->
        Mix.shell().info("#{if ok?, do: "ok", else: "fail"} #{name}")
      end)

      Mix.shell().info("dashboard_url=#{result.dashboard_url}")
    end

    unless result.ok, do: System.halt(1)
  end

  defp read!(relative_or_absolute_path) do
    path =
      if Path.type(relative_or_absolute_path) == :absolute do
        relative_or_absolute_path
      else
        File.cwd!() |> Path.join(relative_or_absolute_path) |> Path.expand()
      end

    File.read!(path)
  end

  defp repo_root do
    File.cwd!()
    |> Path.join("../..")
    |> Path.expand()
  end

  defp dashboard_port do
    System.get_env("TEAM_JAY_DASHBOARD_PORT")
    |> Kernel.||(System.get_env("DASHBOARD_PORT"))
    |> Kernel.||("7787")
    |> String.to_integer()
  end
end
