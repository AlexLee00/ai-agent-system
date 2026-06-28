defmodule Jay.Core.LLM.RecommenderWeights do
  @moduledoc """
  Safe, bounded bias weights for `Jay.Core.LLM.Recommender`.

  Defaults preserve the historical recommender behavior. Learned weights are
  used only when explicitly supplied through context or when the env gate is on.
  """

  @categories [:length, :budget, :failure, :urgency, :task_type, :accuracy]
  @default_weight 1.0 / 6.0
  @floor_weight 0.08
  @ceiling_weight 0.48

  @doc "Supported recommender bias categories."
  def categories, do: @categories

  @doc "Default equal weights. This keeps legacy raw bias values unchanged."
  def default_weights do
    Map.new(@categories, fn category -> {category, @default_weight} end)
  end

  @doc "Normalize a weight map while preserving floor/ceiling and sum ~= 1."
  def normalize(weights, fallback \\ default_weights()) do
    raw =
      Map.new(@categories, fn category ->
        value = get_weight(weights, category, get_weight(fallback, category, @default_weight))
        {category, clamp(number(value, @default_weight), @floor_weight, @ceiling_weight)}
      end)

    normalize_bounded(raw)
  end

  @doc "Return the multiplier for a category relative to equal default weight."
  def multiplier(weights, category) do
    weight = get_weight(weights || default_weights(), category, @default_weight)
    weight / @default_weight
  end

  @doc "Resolve weights from context first, then opt-in env JSON, else defaults."
  def weights_from_context(context \\ %{}) do
    context_weights =
      get_context(context, :llm_recommender_bias_weights) ||
        get_context(context, :bias_weights)

    cond do
      is_map(context_weights) ->
        normalize(context_weights)

      env_enabled?() ->
        weights_from_env()

      true ->
        default_weights()
    end
  end

  defp weights_from_env do
    case Jason.decode(System.get_env("JAY_LLM_RECOMMENDER_WEIGHTS_JSON") || "") do
      {:ok, map} when is_map(map) -> normalize(map)
      _ -> default_weights()
    end
  rescue
    _ -> default_weights()
  end

  defp env_enabled? do
    System.get_env("JAY_LLM_RECOMMENDER_WEIGHTS_ENABLED") == "true"
  end

  defp get_context(context, key) when is_map(context) do
    Map.get(context, key) || Map.get(context, Atom.to_string(key))
  end

  defp get_context(_, _), do: nil

  defp get_weight(map, category, fallback) when is_map(map) do
    Map.get(map, category) ||
      Map.get(map, Atom.to_string(category)) ||
      fallback
  end

  defp get_weight(_, _, fallback), do: fallback

  defp normalize_bounded(weights) do
    total =
      Enum.reduce(@categories, 0.0, fn category, sum -> sum + Map.fetch!(weights, category) end)

    cond do
      total == 0.0 ->
        default_weights()

      abs(total - 1.0) <= 0.000_001 ->
        weights

      total > 1.0 ->
        reduce_excess(weights, total - 1.0)

      true ->
        add_deficit(weights, 1.0 - total)
    end
  end

  defp reduce_excess(weights, excess) do
    adjustable =
      @categories
      |> Enum.map(fn category -> {category, Map.fetch!(weights, category) - @floor_weight} end)
      |> Enum.filter(fn {_category, capacity} -> capacity > 0.0 end)

    capacity_total =
      Enum.reduce(adjustable, 0.0, fn {_category, capacity}, sum -> sum + capacity end)

    if capacity_total <= 0.0 do
      weights
    else
      next =
        Enum.reduce(adjustable, weights, fn {category, capacity}, acc ->
          reduction = min(excess * (capacity / capacity_total), capacity)
          Map.update!(acc, category, &(&1 - reduction))
        end)

      normalize_bounded(next)
    end
  end

  defp add_deficit(weights, deficit) do
    adjustable =
      @categories
      |> Enum.map(fn category -> {category, @ceiling_weight - Map.fetch!(weights, category)} end)
      |> Enum.filter(fn {_category, capacity} -> capacity > 0.0 end)

    capacity_total =
      Enum.reduce(adjustable, 0.0, fn {_category, capacity}, sum -> sum + capacity end)

    if capacity_total <= 0.0 do
      weights
    else
      next =
        Enum.reduce(adjustable, weights, fn {category, capacity}, acc ->
          addition = min(deficit * (capacity / capacity_total), capacity)
          Map.update!(acc, category, &(&1 + addition))
        end)

      normalize_bounded(next)
    end
  end

  defp number(value, _fallback) when is_number(value), do: value * 1.0

  defp number(value, fallback) when is_binary(value) do
    case Float.parse(value) do
      {parsed, ""} -> parsed
      _ -> fallback
    end
  end

  defp number(_, fallback), do: fallback

  defp clamp(value, min, max), do: value |> max(min) |> min(max)
end
