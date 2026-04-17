defmodule Jay.V2.CommandTracker do
  @moduledoc """
  Cross-team command lifecycle tracker.

  알람 전송은 그대로 유지하되, machine-readable command lifecycle을
  EventLake에 일관된 형태로 남긴다.
  """

  alias Jay.V2.CommandEnvelope

  @event_prefix "cross_pipeline.command"

  def issued(pipeline, target_team, envelope, opts \\ []) do
    record(:issued, pipeline, target_team, envelope, opts)
  end

  def acknowledged(pipeline, target_team, envelope, opts \\ []) do
    record(:acknowledged, pipeline, target_team, envelope, opts)
  end

  def failed(pipeline, target_team, envelope, opts \\ []) do
    record(:failed, pipeline, target_team, envelope, opts)
  end

  def completed(pipeline, target_team, envelope, opts \\ []) do
    record(:completed, pipeline, target_team, envelope, opts)
  end

  defp record(status, pipeline, target_team, envelope, opts) do
    severity =
      opts
      |> Keyword.get(:severity)
      |> normalize_severity(status)

    message = Keyword.get(opts, :message, "")
    detail = Keyword.get(opts, :detail)
    pipeline_name = to_string(pipeline)

    Jay.Core.EventLake.record(%{
      team: "jay",
      bot_name: "cross_team_router",
      source: "jay.cross_team_router",
      event_type: "#{@event_prefix}.#{status}",
      severity: severity,
      title: "[#{pipeline_name}] #{status_label(status)}",
      message: message,
      tags: ["cross-team", "command", pipeline_name, to_string(target_team), to_string(status)],
      metadata: %{
        pipeline: pipeline_name,
        target_team: to_string(target_team),
        lifecycle_status: to_string(status),
        summary: CommandEnvelope.summary(envelope),
        command: envelope,
        detail: detail
      }
    })
  rescue
    _ -> :ok
  end

  defp status_label(:issued), do: "command issued"
  defp status_label(:acknowledged), do: "dispatch acknowledged"
  defp status_label(:failed), do: "dispatch failed"
  defp status_label(:completed), do: "command completed"
  defp status_label(status), do: to_string(status)

  defp normalize_severity(nil, :failed), do: "warn"
  defp normalize_severity(nil, _), do: "info"
  defp normalize_severity("warning", _), do: "warn"
  defp normalize_severity(severity, _), do: to_string(severity)
end
