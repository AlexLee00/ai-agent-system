defmodule TeamJay.Blog.SocialExecutionMonitor do
  @moduledoc """
  블로그팀 소셜 채널 실행 결과 모니터.

  인스타그램과 네이버 블로그 채널의 `execution_result`를 받아
  채널별 성공/실패 집계를 유지하고 EventLake에도 남긴다.
  """

  use GenServer

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics
  alias TeamJay.EventLake

  @channels ["instagram", "naver_blog", "facebook"]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  @impl true
  def init(_opts) do
    Enum.each(@channels, fn channel ->
      {:ok, _ref} = PubSub.subscribe(Topics.execution_result(channel))
    end)

    {:ok,
     %{
       total_count: 0,
       ok_count: 0,
       failed_count: 0,
       alert_count: 0,
       by_channel: %{
         "instagram" => %{total_count: 0, ok_count: 0, failed_count: 0},
         "naver_blog" => %{total_count: 0, ok_count: 0, failed_count: 0},
         "facebook" => %{total_count: 0, ok_count: 0, failed_count: 0}
        },
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
       ok_count: state.ok_count,
       failed_count: state.failed_count,
       alert_count: state.alert_count,
       by_channel: state.by_channel,
       last_seen_at: state.last_seen_at,
       last_alert_at: state.last_alert_at,
       last_alerts: state.last_alerts,
       last_results: state.last_results
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:execution_result, channel, result}}, state)
      when channel in @channels do
    summary = summarize_result(channel, result)
    record_execution_result(summary)
    alert = build_alert(summary)

    if alert do
      record_execution_alert(alert)
      :ok = PubSub.broadcast_execution_alert(channel, alert)
    end

    channel_state =
      state.by_channel
      |> Map.get(channel, %{total_count: 0, ok_count: 0, failed_count: 0})
      |> Map.update!(:total_count, &(&1 + 1))
      |> Map.update!(:ok_count, &(&1 + if(summary.ok, do: 1, else: 0)))
      |> Map.update!(:failed_count, &(&1 + if(summary.ok, do: 0, else: 1)))

    {:noreply,
     %{
       state
       | total_count: state.total_count + 1,
         ok_count: state.ok_count + if(summary.ok, do: 1, else: 0),
         failed_count: state.failed_count + if(summary.ok, do: 0, else: 1),
         alert_count: state.alert_count + if(alert, do: 1, else: 0),
         by_channel: Map.put(state.by_channel, channel, channel_state),
         last_seen_at: DateTime.utc_now(),
         last_alert_at: if(alert, do: DateTime.utc_now(), else: state.last_alert_at),
         last_alerts:
           if(alert,
             do: [alert | Enum.take(state.last_alerts, 4)],
             else: state.last_alerts
           ),
         last_results: [summary | Enum.take(state.last_results, 5)]
     }}
  end

  defp summarize_result(channel, result) do
    smoke_test =
      case Map.get(result, :smoke_test) || get_in(result, [:payload, :smoke_test]) do
        true -> true
        "true" -> true
        _ -> false
      end

    %{
      target: channel,
      run_status: Map.get(result, :run_status),
      ok: Map.get(result, :ok, false),
      exit_code: Map.get(result, :exit_code),
      post_type: get_in(result, [:payload, :post_type]),
      writer: get_in(result, [:payload, :writer]),
      date: get_in(result, [:payload, :date]),
      smoke_test: smoke_test,
      failure_kind: detect_failure_kind(result),
      finished_at: Map.get(result, :finished_at),
      duration_ms: Map.get(result, :duration_ms)
    }
  end

  defp record_execution_result(summary) do
    EventLake.record(%{
      event_type: "blog_phase1_social_execution_result",
      team: "blog",
      bot_name: "social_execution_monitor",
      severity: if(summary.ok, do: "info", else: "warn"),
      title: "[blog-phase1-social] #{summary.target} #{summary.run_status}",
      message:
        "target=#{summary.target} post_type=#{summary.post_type} writer=#{summary.writer} date=#{summary.date} ok=#{summary.ok} exit_code=#{inspect(summary.exit_code)} failure_kind=#{summary.failure_kind || "none"} smoke_test=#{summary.smoke_test}",
      tags: ["phase1", "blog", "social_execution", "target:#{summary.target}"],
      metadata: summary
    })
  end

  defp build_alert(summary) do
    if summary.ok do
      nil
    else
      %{
        target: summary.target,
        post_type: summary.post_type,
        writer: summary.writer,
        date: summary.date,
        run_status: summary.run_status,
        exit_code: summary.exit_code,
        failure_kind: summary.failure_kind,
        smoke_test: summary.smoke_test
      }
    end
  end

  defp record_execution_alert(alert) do
    EventLake.record(%{
      event_type: "blog_phase1_social_execution_alert",
      team: "blog",
      bot_name: "social_execution_monitor",
      severity: "warn",
      title: "[blog-phase1-social-alert] #{alert.target} #{alert.run_status}",
      message:
        "target=#{alert.target} post_type=#{alert.post_type} writer=#{alert.writer} date=#{alert.date} exit_code=#{inspect(alert.exit_code)} failure_kind=#{alert.failure_kind || "none"} smoke_test=#{alert.smoke_test}",
      tags: ["phase1", "blog", "social_execution_alert", "target:#{alert.target}"],
      metadata: alert
    })
  end

  defp detect_failure_kind(result) do
    if Map.get(result, :ok, false) do
      nil
    else
      explicit = Map.get(result, :failure_kind) || get_in(result, [:payload, :failure_kind])

      cond do
        is_binary(explicit) and explicit != "" ->
          explicit

        Map.get(result, :run_status) in [:forced_failure, "forced_failure"] ->
          "smoke"

        Map.get(result, :exit_code) in [401, 403] ->
          "auth"

        Map.get(result, :exit_code) in [422, 429] ->
          "upload"

        Map.get(result, :exit_code) in [500, 502, 503, 504] ->
          "publish"

        true ->
          "unknown"
      end
    end
  end
end
