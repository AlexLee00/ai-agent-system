defmodule Sigma.V2.Signal do
  @moduledoc """
  Jido.Signal 래퍼 — sigma.* 네이밍 규약 + CloudEvents v1.0.
  Phoenix.PubSub(Sigma.V2.PubSub) 브로드캐스트.
  참조: bots/sigma/docs/PLAN.md §6 Phase 2
  """

  @doc "Signal 발행 — PubSub 브로드캐스트."
  @spec emit(map()) :: {:ok, String.t()} | {:error, term()}
  def emit(payload) do
    signal_id = Ecto.UUID.generate()

    message = %{
      id: signal_id,
      source: Map.get(payload, :source, "sigma-v2"),
      type: payload.type,
      specversion: "1.0",
      datacontenttype: "application/json",
      time: DateTime.utc_now() |> DateTime.to_iso8601(),
      data: Map.get(payload, :data, %{}),
      metadata: Map.get(payload, :metadata, %{})
    }

    topic = "sigma:#{payload.type}"

    case Phoenix.PubSub.broadcast(Sigma.V2.PubSub, topic, {:sigma_signal, message}) do
      :ok -> {:ok, signal_id}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc "팀 Signal 구독."
  @spec subscribe(String.t()) :: :ok | {:error, term()}
  def subscribe(team) do
    Phoenix.PubSub.subscribe(Sigma.V2.PubSub, "sigma:sigma.advisory.#{team}")
  end

  @doc "임의 topic 구독."
  @spec subscribe_topic(String.t()) :: :ok | {:error, term()}
  def subscribe_topic(topic) do
    Phoenix.PubSub.subscribe(Sigma.V2.PubSub, topic)
  end
end
