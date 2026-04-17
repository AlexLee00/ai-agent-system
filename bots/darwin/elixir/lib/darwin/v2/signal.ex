defmodule Darwin.V2.Signal do
  @moduledoc """
  다윈 V2 이벤트 신호 — CloudEvents v1.0 호환 이벤트 발행.

  JayBus(Registry pub/sub) 기반.
  주요 이벤트: paper_discovered, paper_evaluated, cycle_completed, autonomy_upgraded.
  """

  require Logger

  @app_source "darwin.v2"

  @doc "다윈 V2 이벤트 발행."
  def emit(type, data, opts \\ []) do
    event = %{
      specversion: "1.0",
      id: Ecto.UUID.generate(),
      source: @app_source,
      type: "#{@app_source}.#{type}",
      time: DateTime.to_iso8601(DateTime.utc_now()),
      data: data,
      team: Keyword.get(opts, :team, "darwin")
    }

    # JayBus 브로드캐스트
    topic = "darwin.#{type}"
    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries do
        send(pid, {:jay_event, topic, event})
      end
    end)

    Logger.debug("[darwin/signal] 이벤트 발행: #{type}")
    {:ok, event}
  rescue
    e ->
      Logger.warning("[darwin/signal] 발행 실패: #{inspect(e)}")
      {:error, e}
  end

  @doc "다윈 V2 이벤트 구독 (현재 프로세스 등록)."
  def subscribe(type) do
    topic = "darwin.#{type}"
    Registry.register(Jay.Core.JayBus, topic, [])
  end

  # 주요 이벤트 헬퍼
  def paper_discovered(paper), do: emit(:paper_discovered, %{paper: paper})
  def paper_evaluated(paper, score), do: emit(:paper_evaluated, %{paper: paper, score: score})
  def cycle_completed(cycle_id, outcome), do: emit(:cycle_completed, %{cycle_id: cycle_id, outcome: outcome})
  def autonomy_upgraded(from_level, to_level), do: emit(:autonomy_upgraded, %{from: from_level, to: to_level})
end
