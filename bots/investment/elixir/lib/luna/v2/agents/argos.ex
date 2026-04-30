defmodule Luna.V2.Agents.Argos do
  @moduledoc """
  Shadow-only parallel screening agent.
  """

  def screen(candidates \\ []) do
    scored =
      Enum.map(candidates, fn candidate ->
        score = Map.get(candidate, :score, Map.get(candidate, "score", 0.5))
        Map.put(candidate, :argos_score, score)
      end)

    %{agent: "argos", shadow: true, count: length(scored), candidates: scored}
  end
end
