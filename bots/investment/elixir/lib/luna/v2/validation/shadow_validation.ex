defmodule Luna.V2.Validation.ShadowValidation do
  @moduledoc """
  Validation Stage 3 — Shadow Mode 병렬 비교 결과 집계.

  luna_v2_shadow_comparison 최근 7일 레코드 집계.
  similarity 평균 ≥ 0.80 이면 pass.
  """
  require Logger

  @lookback_days 7
  @min_runs      10
  @pass_similarity 0.80

  @doc """
  strategy 맵을 받아 shadow 결과 반환.

  반환: {:ok, %{type: :shadow, runs, avg_score, pass}}
  """
  def run(strategy) do
    market = strategy[:market] || "crypto"
    Logger.debug("[ShadowValidation] market=#{market}")

    query = """
    SELECT
      COUNT(*)        AS runs,
      AVG(score)      AS avg_score,
      AVG(similarity) AS avg_similarity
    FROM luna_v2_shadow_comparison
    WHERE market = $1
      AND created_at > NOW() - ($2 || ' days')::interval
    """
    case Jay.Core.Repo.query(query, [to_string(market), to_string(@lookback_days)]) do
      {:ok, %{rows: [[runs, avg_score, avg_sim | _] | _]}} ->
        runs_i   = to_i(runs)
        sim_f    = to_f(avg_sim)
        {:ok, %{
          type:     :shadow,
          runs:     runs_i,
          avg_score: to_f(avg_score),
          avg_similarity: sim_f,
          pass:     runs_i >= @min_runs and sim_f >= @pass_similarity
        }}

      _ ->
        {:ok, %{type: :shadow, runs: 0, avg_score: 0.0, avg_similarity: 0.0, pass: false}}
    end
  rescue
    e ->
      Logger.error("[ShadowValidation] 예외: #{inspect(e)}")
      {:ok, %{type: :shadow, runs: 0, avg_score: 0.0, avg_similarity: 0.0, pass: false}}
  end

  defp to_f(nil), do: 0.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(_), do: 0.0

  defp to_i(nil), do: 0
  defp to_i(d) when is_struct(d, Decimal), do: Decimal.to_integer(d)
  defp to_i(n) when is_integer(n), do: n
  defp to_i(n) when is_float(n), do: round(n)
  defp to_i(_), do: 0
end
