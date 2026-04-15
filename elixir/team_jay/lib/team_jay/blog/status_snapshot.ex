defmodule TeamJay.Blog.StatusSnapshot do
  @moduledoc """
  블로그팀 Phase 1 상태 스냅샷 도우미.

  각 GenServer의 상태를 안전하게 모아서 운영자가 한 번에 볼 수 있는
  요약 payload를 만든다.
  """

  alias TeamJay.Blog

  def collect do
    %{
      orchestrator: safe_status(Blog.Orchestrator),
      researcher: safe_status(Blog.Researcher),
      writer_pos: safe_status(Blog.Writer.Pos),
      writer_gems: safe_status(Blog.Writer.Gems),
      editor: safe_status(Blog.Editor),
      publisher: safe_status(Blog.Publisher),
      port_bridge: safe_status(Blog.PortBridge),
      node_publish_agent: safe_status(Blog.NodePublishAgent),
      node_publish_executor: safe_status(Blog.NodePublishExecutor),
      node_publish_runner: safe_status(Blog.NodePublishRunner),
      execution_monitor: safe_status(Blog.ExecutionMonitor),
      alert_relay: safe_status(Blog.AlertRelay),
      feedback: safe_status(Blog.Feedback),
      social_relay: safe_status(Blog.SocialRelay),
      instagram_agent: safe_status(Blog.InstagramAgent),
      instagram_executor: safe_status(Blog.InstagramExecutor),
      instagram_runner: safe_status(Blog.InstagramRunner),
      facebook_agent: safe_status(Blog.FacebookAgent),
      facebook_executor: safe_status(Blog.FacebookExecutor),
      facebook_runner: safe_status(Blog.FacebookRunner),
      naver_blog_agent: safe_status(Blog.NaverBlogAgent),
      naver_blog_executor: safe_status(Blog.NaverBlogExecutor),
      naver_blog_runner: safe_status(Blog.NaverBlogRunner),
      social_execution_monitor: safe_status(Blog.SocialExecutionMonitor),
      social_alert_relay: safe_status(Blog.SocialAlertRelay)
    }
    |> normalize()
  end

  defp safe_status(module) do
    if Code.ensure_loaded?(module) and function_exported?(module, :status, 0) do
      module.status()
    else
      %{error: :status_unavailable}
    end
  rescue
    error -> %{error: :exception, reason: Exception.message(error)}
  catch
    :exit, reason -> %{error: :exit, reason: inspect(reason)}
    kind, reason -> %{error: kind, reason: inspect(reason)}
  end

  defp normalize(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp normalize(%Date{} = value), do: Date.to_iso8601(value)
  defp normalize(%NaiveDateTime{} = value), do: NaiveDateTime.to_iso8601(value)
  defp normalize(%Time{} = value), do: Time.to_iso8601(value)
  defp normalize(value) when is_map(value), do: Map.new(value, fn {k, v} -> {k, normalize(v)} end)
  defp normalize(value) when is_list(value), do: Enum.map(value, &normalize/1)
  defp normalize(value) when is_tuple(value), do: value |> Tuple.to_list() |> Enum.map(&normalize/1)
  defp normalize(value), do: value
end
