defmodule TeamJay.Jay.N8nBridge do
  @moduledoc """
  JayBus ↔ n8n 웹훅 브릿지

  Elixir PubSub(JayBus) 이벤트 → n8n 웹훅 포워딩

  연동 이벤트:
  - blog.post.published      → 블로그팀 동적 포스팅 워크플로우
  - darwin.applied.*         → 다윈팀 연구 적용 알림 워크플로우
  - system_error             → CRITICAL 알림 에스컬레이션 워크플로우
  - investment.trade.closed  → 주간 매매 성과 요약 워크플로우

  워크플로우 트리거 방식:
  Hub /hub/n8n/webhook/:path 경유 (인증 포함)
  """

  use GenServer
  require Logger

  alias TeamJay.HubClient

  # JayBus 구독 토픽 → n8n 웹훅 경로 매핑
  @topic_webhook_map %{
    "blog.post.published"     => "blog-dynamic-posting",
    "system_error"            => "critical-alert-escalation",
    "port_agent_failed"       => "critical-alert-escalation",
    "investment.trade.closed" => "weekly-trade-summary"
  }

  # darwin.applied.* 패턴은 별도 처리
  @darwin_applied_webhook "darwin-research-applied"

  defstruct [forwarded: 0, errors: 0, last_forwarded_at: nil]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[N8nBridge] JayBus↔n8n 브릿지 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Enum.each(Map.keys(@topic_webhook_map), fn topic ->
      Registry.register(TeamJay.JayBus, topic, [])
    end)
    # darwin.applied.* 전체 구독 (팀별)
    Enum.each([:luna, :blog, :claude, :ska, :jay], fn team ->
      Registry.register(TeamJay.JayBus, "darwin.applied.#{team}", [])
    end)
    Logger.debug("[N8nBridge] #{map_size(@topic_webhook_map) + 5}개 토픽 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state) do
    webhook_path = resolve_webhook(topic)

    if webhook_path do
      new_state = forward_to_n8n(webhook_path, topic, payload, state)
      {:noreply, new_state}
    else
      {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      forwarded: state.forwarded,
      errors: state.errors,
      last_forwarded_at: state.last_forwarded_at
    }, state}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp resolve_webhook("darwin.applied." <> _team), do: @darwin_applied_webhook
  defp resolve_webhook(topic), do: Map.get(@topic_webhook_map, topic)

  defp forward_to_n8n(webhook_path, topic, payload, state) do
    body = build_payload(topic, payload)

    Task.start(fn ->
      case HubClient.post_n8n_webhook(webhook_path, body) do
        {:ok, _} ->
          Logger.debug("[N8nBridge] 포워딩 완료: #{topic} → #{webhook_path}")
        {:error, reason} ->
          Logger.warning("[N8nBridge] 포워딩 실패: #{topic} → #{webhook_path} (#{inspect(reason)})")
      end
    end)

    %{state |
      forwarded: state.forwarded + 1,
      last_forwarded_at: DateTime.utc_now()
    }
  end

  defp build_payload(topic, payload) do
    %{
      source: "elixir_jaybus",
      topic: topic,
      timestamp: DateTime.to_iso8601(DateTime.utc_now()),
      data: sanitize(payload)
    }
  end

  # pid 등 직렬화 불가 값 제거
  defp sanitize(payload) when is_map(payload) do
    payload
    |> Enum.reject(fn {_, v} -> is_pid(v) or is_reference(v) end)
    |> Map.new()
  end
  defp sanitize(payload), do: payload
end
