defmodule TeamJay.Investment.Events do
  @moduledoc """
  투자팀 Elixir 네이티브 파이프라인에서 사용하는 이벤트 payload 헬퍼.

  현재는 스캐폴드 Worker들이 동일한 키 구조를 공유하도록 만드는 역할만 한다.
  실제 브로커/LLM 연동 전까지는 lightweight map builder로 유지한다.
  """

  def indicator(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :indicator_scaffold,
        generated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def analysis(symbol, analyst_type, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        analyst_type: analyst_type,
        source: :analyst_scaffold,
        confidence: 0.0,
        generated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def signal(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        action: :hold,
        source: :decision_scaffold,
        confidence: 0.0,
        generated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def approved_signal(signal, attrs \\ %{}) do
    Map.merge(
      %{
        signal: signal,
        source: :risk_scaffold,
        approved: true,
        reviewed_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def trade_result(symbol, approved_signal, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :execution_scaffold,
        executed: true,
        executed_at: DateTime.utc_now(),
        approved_signal: approved_signal
      },
      Map.new(attrs)
    )
  end
end
