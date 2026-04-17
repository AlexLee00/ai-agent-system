defmodule Sigma.V2.Telemetry do
  @moduledoc """
  Sigma V2 텔레메트리 — Jido 이벤트 핸들러 + 시그마 고유 메트릭 수집.
  Phase 1: 파일 exporter.
  Phase 4: SIGMA_OTEL_EXPORTER=otlp 설정 시 OTLP 엔드포인트로 전송.
  """

  require Logger

  @events [
    [:jido, :agent, :execute, :start],
    [:jido, :agent, :execute, :stop],
    [:jido, :action, :run, :start],
    [:jido, :action, :run, :stop]
  ]

  def setup do
    :telemetry.attach_many(
      "sigma-v2-handler",
      @events,
      &__MODULE__.handle_event/4,
      nil
    )

    :ok
  end

  def handle_event([:jido, :agent, :execute, :start], measurements, metadata, _config) do
    Logger.debug("[sigma_v2][agent:start] agent=#{inspect(metadata[:agent])} measurements=#{inspect(measurements)}")
  end

  def handle_event([:jido, :agent, :execute, :stop], measurements, metadata, _config) do
    duration_ms = div(measurements[:duration] || 0, 1_000_000)
    Logger.info("[sigma_v2][agent:stop] agent=#{inspect(metadata[:agent])} duration=#{duration_ms}ms")
    record_metric(:agent_execute_duration_ms, duration_ms, metadata)
  end

  def handle_event([:jido, :action, :run, :start], _measurements, metadata, _config) do
    Logger.debug("[sigma_v2][action:start] action=#{inspect(metadata[:action])}")
  end

  def handle_event([:jido, :action, :run, :stop], measurements, metadata, _config) do
    duration_ms = div(measurements[:duration] || 0, 1_000_000)
    success = metadata[:result] == :ok
    Logger.info("[sigma_v2][action:stop] action=#{inspect(metadata[:action])} duration=#{duration_ms}ms success=#{success}")
    record_metric(:action_run_duration_ms, duration_ms, metadata)
  end

  def handle_event(event, measurements, metadata, _config) do
    Logger.debug("[sigma_v2][event] #{inspect(event)} measurements=#{inspect(measurements)} metadata=#{inspect(metadata)}")
  end

  def span(name, metadata, fun) do
    start = System.monotonic_time()
    result = fun.()
    duration = System.monotonic_time() - start
    Logger.debug("[sigma_v2][span] #{name} duration=#{div(duration, 1_000_000)}ms metadata=#{inspect(metadata)}")
    result
  end

  # -------------------------------------------------------------------
  # 시그마 고유 메트릭 기록 (파일 exporter → /tmp/sigma_v2_metrics.jsonl)
  # -------------------------------------------------------------------

  defp record_metric(name, value, metadata) do
    entry =
      Jason.encode!(%{
        metric: name,
        value: value,
        metadata: sanitize(metadata),
        timestamp: DateTime.utc_now() |> DateTime.to_iso8601()
      })

    case System.get_env("SIGMA_OTEL_EXPORTER") do
      "otlp" ->
        # Phase 4 OTLP 전송 — 기본은 파일 유지
        otlp_endpoint = System.get_env("OTLP_ENDPOINT", "http://localhost:4318")
        Task.start(fn ->
          Req.post("#{otlp_endpoint}/v1/metrics",
            body: entry,
            headers: [{"content-type", "application/json"}],
            receive_timeout: 3_000
          )
        end)

      _ ->
        File.write("/tmp/sigma_v2_metrics.jsonl", entry <> "\n", [:append])
    end
  rescue
    _ -> :ok
  end

  defp sanitize(metadata) when is_map(metadata) do
    metadata
    |> Enum.reject(fn {_k, v} -> is_function(v) or is_pid(v) or is_reference(v) end)
    |> Enum.map(fn {k, v} -> {k, inspect(v)} end)
    |> Map.new()
  end
  defp sanitize(_), do: %{}
end
