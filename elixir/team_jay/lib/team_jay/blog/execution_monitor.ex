defmodule TeamJay.Blog.ExecutionMonitor do
  @moduledoc """
  블로그팀 실행 결과 모니터 스캐폴드.

  `execution_result:node_publish` 이벤트를 받아 verify/dry-run 결과를
  집계하고 최근 실행 이력을 유지한다.

  현재는 EventLake 적재 없이 메모리 상태로만 요약을 제공하는
  Phase 1 관측 레이어다.
  """

  use GenServer

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics
  alias Jay.Core.EventLake

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  @impl true
  def init(_opts) do
    {:ok, _ref} = PubSub.subscribe(Topics.execution_result("node_publish"))

    {:ok,
     %{
       total_count: 0,
       verify_ok_count: 0,
       dry_run_ok_count: 0,
       failed_count: 0,
       alert_count: 0,
       last_seen_at: nil,
       last_alert_at: nil,
       last_alerts: [],
       last_results: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       total_count: state.total_count,
       verify_ok_count: state.verify_ok_count,
       dry_run_ok_count: state.dry_run_ok_count,
       failed_count: state.failed_count,
       alert_count: state.alert_count,
       last_seen_at: state.last_seen_at,
       last_alert_at: state.last_alert_at,
       last_alerts: state.last_alerts,
       last_results: state.last_results
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:execution_result, "node_publish", result}}, state) do
    summarized = summarize_result(result)
    record_execution_result(summarized)
    alert = build_alert(summarized)

    if alert do
      record_execution_alert(alert)
      :ok = PubSub.broadcast_execution_alert("node_publish", alert)
    end

    {:noreply,
     %{
       state
       | total_count: state.total_count + 1,
         verify_ok_count: state.verify_ok_count + if(result.ok, do: 1, else: 0),
         dry_run_ok_count: state.dry_run_ok_count + if(result.dry_run_ok, do: 1, else: 0),
         failed_count: state.failed_count + if(result.ok && result.dry_run_ok, do: 0, else: 1),
         alert_count: state.alert_count + if(alert, do: 1, else: 0),
         last_seen_at: DateTime.utc_now(),
         last_alert_at: if(alert, do: DateTime.utc_now(), else: state.last_alert_at),
         last_alerts:
           if(alert,
             do: [alert | Enum.take(state.last_alerts, 4)],
             else: state.last_alerts
           ),
         last_results: [summarized | Enum.take(state.last_results, 4)]
     }}
  end

  defp summarize_result(result) do
    %{
      target: result.target,
      run_status: result.run_status,
      ok: result.ok,
      dry_run_ok: Map.get(result, :dry_run_ok, false),
      exit_code: result.exit_code,
      dry_run_exit_code: Map.get(result, :dry_run_exit_code),
      verify_status: Map.get(result, :verify_status),
      dry_run_status: Map.get(result, :dry_run_status),
      verify_duration_ms: Map.get(result, :verify_duration_ms),
      dry_run_duration_ms: Map.get(result, :dry_run_duration_ms),
      post_type: get_in(result, [:payload, :post_type]),
      writer: get_in(result, [:payload, :writer]),
      date: get_in(result, [:payload, :date]),
      output_preview: Map.get(result, :output_preview, ""),
      dry_run_output_preview: Map.get(result, :dry_run_output_preview, "")
    }
  end

  defp record_execution_result(summary) do
    EventLake.record(%{
      event_type: "blog_phase1_execution_result",
      team: "blog",
      bot_name: "execution_monitor",
      severity: if(summary.ok && summary.dry_run_ok, do: "info", else: "warn"),
      title: build_title(summary),
      message: build_message(summary),
      tags: ["phase1", "blog", "execution_result", "target:node_publish"],
      metadata: %{
        target: summary.target,
        run_status: summary.run_status,
        ok: summary.ok,
        dry_run_ok: summary.dry_run_ok,
        exit_code: summary.exit_code,
        dry_run_exit_code: summary.dry_run_exit_code,
        verify_status: summary.verify_status,
        dry_run_status: summary.dry_run_status,
        verify_duration_ms: summary.verify_duration_ms,
        dry_run_duration_ms: summary.dry_run_duration_ms,
        post_type: summary.post_type,
        writer: summary.writer,
        date: summary.date
      }
    })
  end

  defp build_alert(summary) do
    if summary.ok && summary.dry_run_ok do
      nil
    else
      %{
        target: summary.target,
        post_type: summary.post_type,
        writer: summary.writer,
        date: summary.date,
        run_status: summary.run_status,
        verify_status: summary.verify_status,
        dry_run_status: summary.dry_run_status,
        exit_code: summary.exit_code,
        dry_run_exit_code: summary.dry_run_exit_code,
        preview:
          String.slice(
            summary.dry_run_output_preview || summary.output_preview || "",
            0,
            200
          )
      }
    end
  end

  defp record_execution_alert(alert) do
    EventLake.record(%{
      event_type: "blog_phase1_execution_alert",
      team: "blog",
      bot_name: "execution_monitor",
      severity: "warn",
      title: build_alert_title(alert),
      message: build_alert_message(alert),
      tags: ["phase1", "blog", "execution_alert", "target:node_publish"],
      metadata: alert
    })
  end

  defp build_title(summary) do
    "[blog-phase1] #{summary.post_type || "unknown"} #{summary.run_status}"
  end

  defp build_message(summary) do
    [
      "target=#{summary.target}",
      "post_type=#{summary.post_type}",
      "writer=#{summary.writer}",
      "date=#{summary.date}",
      "ok=#{summary.ok}",
      "dry_run_ok=#{summary.dry_run_ok}",
      "exit_code=#{inspect(summary.exit_code)}",
      "dry_run_exit_code=#{inspect(summary.dry_run_exit_code)}"
    ]
    |> Enum.join(" ")
  end

  defp build_alert_title(alert) do
    "[blog-phase1-alert] #{alert.post_type || "unknown"} #{alert.run_status}"
  end

  defp build_alert_message(alert) do
    [
      "target=#{alert.target}",
      "post_type=#{alert.post_type}",
      "writer=#{alert.writer}",
      "date=#{alert.date}",
      "verify_status=#{inspect(alert.verify_status)}",
      "dry_run_status=#{inspect(alert.dry_run_status)}",
      "exit_code=#{inspect(alert.exit_code)}",
      "dry_run_exit_code=#{inspect(alert.dry_run_exit_code)}",
      "preview=#{alert.preview}"
    ]
    |> Enum.join(" ")
  end
end
