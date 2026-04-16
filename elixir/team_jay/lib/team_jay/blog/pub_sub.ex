defmodule TeamJay.Blog.PubSub do
  @moduledoc """
  블로그팀 전용 이벤트 버스 스캐폴드.

  Phase 1 목표는 Phoenix.PubSub 기반이지만,
  현재는 병렬 운영에 영향을 주지 않는 Registry 기반 shim을 먼저 둔다.
  """

  @registry TeamJay.BlogBus

  def subscribe(topic) when is_binary(topic) do
    Registry.register(@registry, topic, [])
  end

  def unsubscribe(topic) when is_binary(topic) do
    Registry.unregister(@registry, topic)
  end

  def broadcast(topic, message) when is_binary(topic) do
    Registry.dispatch(@registry, topic, fn entries ->
      Enum.each(entries, fn {pid, _meta} -> send(pid, {:blog_event, topic, message}) end)
    end)

    :ok
  end

  def broadcast_schedule(posts) when is_list(posts) do
    TeamJay.Blog.Topics.schedule()
    |> broadcast({:start_research, posts})
  end

  def broadcast_draft_ready(writer, draft) when is_binary(writer) do
    TeamJay.Blog.Topics.draft_ready(writer)
    |> broadcast({:draft_ready, writer, draft})
  end

  def broadcast_published(post_payload) do
    TeamJay.Blog.Topics.published()
    |> broadcast({:published, post_payload})
  end

  def broadcast_handoff(target, payload) when is_binary(target) do
    TeamJay.Blog.Topics.handoff(target)
    |> broadcast({:handoff_ready, target, payload})
  end

  def broadcast_execution(target, payload) when is_binary(target) do
    TeamJay.Blog.Topics.execution(target)
    |> broadcast({:execution_ready, target, payload})
  end

  def broadcast_execution_result(target, payload) when is_binary(target) do
    TeamJay.Blog.Topics.execution_result(target)
    |> broadcast({:execution_result, target, payload})
  end

  def broadcast_execution_alert(target, payload) when is_binary(target) do
    TeamJay.Blog.Topics.execution_alert(target)
    |> broadcast({:execution_alert, target, payload})
  end

  def broadcast_cross_team_command(action_type, payload) do
    TeamJay.Blog.Topics.cross_team_commands()
    |> broadcast(%{
      action_type: action_type,
      payload: payload,
      at: DateTime.utc_now()
    })
  end

  def broadcast_promotion_request(payload) do
    TeamJay.Blog.Topics.promotion_requests()
    |> broadcast(%{kind: :promotion, payload: payload, at: DateTime.utc_now()})
  end

  def broadcast_investment_content_request(payload) do
    TeamJay.Blog.Topics.investment_content_requests()
    |> broadcast(%{kind: :investment, payload: payload, at: DateTime.utc_now()})
  end
end
