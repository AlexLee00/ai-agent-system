defmodule TeamJay.Investment.Topics do
  @moduledoc """
  투자팀 이벤트 버스용 토픽 정의.

  현재는 병렬 운영에 영향 없는 Phase 1 스캐폴드다.
  런타임 메인 경로는 여전히 PortAgent + launchd 병렬 구조를 사용한다.
  """

  def market_events(market), do: "investment:market_events:#{market}"
  def trade_events(symbol), do: "investment:trade_events:#{symbol}"
  def indicators(symbol), do: "investment:indicators:#{symbol}"
  def analysis(symbol), do: "investment:analysis:#{symbol}"
  def signal(symbol), do: "investment:signal:#{symbol}"
  def approved_signal(symbol), do: "investment:approved_signal:#{symbol}"
  def trade_result(symbol), do: "investment:trade_result:#{symbol}"
  def feedback(symbol), do: "investment:feedback:#{symbol}"
end
