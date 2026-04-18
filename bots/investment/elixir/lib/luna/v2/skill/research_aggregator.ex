defmodule Luna.V2.Skill.ResearchAggregator do
  @moduledoc """
  11 분석가 결과 병렬 수집 (Jido.Action 기반).

  기존 TS/JS 에이전트를 Hub PortAgent 호출로 실행.
  Zeus/Athena는 ambiguity 높을 때만 조건부 실행.
  """
  use Jido.Action,
    name:        "research_aggregator",
    description: "11 분석가 신호 병렬 수집 및 통합",
    schema: [
      market: [type: :atom, required: true]
    ]

  require Logger

  @base_analysts ~w[argos aria hermes sophia oracle]a
  @debate_analysts ~w[zeus athena]a

  @impl true
  def run(%{market: market}, _context) do
    Logger.info("[ResearchAggregator] 분석가 수집 시작 — market=#{market}")

    base_tasks = Enum.map(@base_analysts, fn analyst ->
      Task.async(fn -> {analyst, call_analyst(analyst, market)} end)
    end)

    base_results =
      Task.await_many(base_tasks, 60_000)
      |> Enum.into(%{})

    debate_results =
      if needs_debate?(base_results) do
        Logger.info("[ResearchAggregator] ambiguity 높음 — Zeus/Athena 토론 실행")
        run_debate(base_results, market)
      else
        %{zeus: :skipped, athena: :skipped}
      end

    combined = Map.merge(base_results, debate_results)
    {:ok, %{research: combined, market: market, collected_at: DateTime.utc_now()}}
  end

  defp needs_debate?(results) do
    scores = results
    |> Map.values()
    |> Enum.filter(&is_map/1)
    |> Enum.map(&Map.get(&1, :confidence, 0.5))

    if length(scores) < 2 do
      false
    else
      avg = Enum.sum(scores) / length(scores)
      variance = Enum.reduce(scores, 0, fn s, acc -> acc + (s - avg) * (s - avg) end) / length(scores)
      stdev = :math.sqrt(variance)
      stdev > 0.3 or avg < 0.6
    end
  end

  defp run_debate(base_results, market) do
    tasks = Enum.map(@debate_analysts, fn analyst ->
      Task.async(fn -> {analyst, call_analyst(analyst, market, %{base_research: base_results})} end)
    end)
    Task.await_many(tasks, 90_000) |> Enum.into(%{})
  end

  defp call_analyst(analyst, market, extra \\ %{}) do
    hub_url = System.get_env("HUB_BASE_URL", "http://localhost:7788")
    hub_token = System.get_env("HUB_AUTH_TOKEN", "")

    payload = Map.merge(%{agent: to_string(analyst), market: to_string(market)}, extra)

    case Req.post("#{hub_url}/hub/investment/analyst/call",
           json: payload,
           headers: [{"Authorization", "Bearer #{hub_token}"}],
           receive_timeout: 55_000) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        %{signal: body["signal"], confidence: body["confidence"] || 0.5, data: body}
      {:ok, %Req.Response{status: status}} ->
        Logger.warning("[ResearchAggregator] #{analyst} HTTP #{status}")
        %{signal: :neutral, confidence: 0.3, error: "http_#{status}"}
      {:error, err} ->
        Logger.warning("[ResearchAggregator] #{analyst} 오류: #{inspect(err)}")
        %{signal: :neutral, confidence: 0.0, error: inspect(err)}
    end
  end
end
