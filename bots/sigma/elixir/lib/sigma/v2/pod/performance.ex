defmodule Sigma.V2.Pod.Performance do
  @moduledoc """
  Pod 성과 추적 (Phase O).

  3개 Pod(Trend/Growth/Risk)의 판단 정확도를 추적:
  - 각 Pod의 Directive 수락률, 이행률 기록
  - 주간 정확도 집계 → 이상 감지 시 Telegram 알림
  - AgentSelector UCB1 스코어 업데이트 연동

  Pod 정확도 = (이행된 Directive / 발행된 Directive) × 수락률
  """

  require Logger

  @anomaly_threshold 0.2

  @doc "Directive 실행 결과를 Pod 성과 테이블에 기록."
  @spec record_directive(String.t(), String.t(), String.t(), boolean()) :: :ok
  def record_directive(pod_name, team, directive_id, success) do
    sql = """
    INSERT INTO sigma_pod_performance
      (pod_name, team, directive_id, success, evaluated_at)
    VALUES ($1, $2, $3, $4, NOW())
    """

    Jay.Core.Repo.query(sql, [pod_name, team, directive_id, success])
    :ok
  rescue
    e ->
      Logger.warning("[Sigma.V2.Pod.Performance] record_directive 실패: #{inspect(e)}")
      :ok
  end

  @doc "주간 Pod 정확도 집계 + 이상 감지 — MapeKLoop 주간 Knowledge에서 호출."
  @spec evaluate_weekly() :: :ok
  def evaluate_weekly do
    sql = """
    SELECT
      pod_name,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE success = true)::float / NULLIF(COUNT(*), 0) AS accuracy
    FROM sigma_pod_performance
    WHERE evaluated_at >= NOW() - INTERVAL '7 days'
    GROUP BY pod_name
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [pod_name, total, accuracy] ->
          acc = accuracy || 0.0
          baseline = get_baseline(pod_name)

          if baseline > 0 and abs(acc - baseline) >= @anomaly_threshold do
            try do
              Sigma.V2.TelegramReporter.on_pod_anomaly(pod_name, acc, baseline)
            rescue
              _ -> :ok
            end
          end

          update_ucb_score(pod_name, acc, to_int(total))
          Logger.info("[Sigma.V2.Pod.Performance] #{pod_name}: accuracy=#{Float.round(acc * 1.0, 3)}, total=#{total}")
        end)

        :ok

      _ ->
        Logger.debug("[Sigma.V2.Pod.Performance] DB 접근 불가")
        :ok
    end
  rescue
    e ->
      Logger.warning("[Sigma.V2.Pod.Performance] evaluate_weekly 실패: #{inspect(e)}")
      :ok
  end

  @doc "Pod별 최근 정확도 조회."
  @spec accuracy_by_pod(integer()) :: map()
  def accuracy_by_pod(days \\ 30) do
    sql = """
    SELECT
      pod_name,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE success = true)::float / NULLIF(COUNT(*), 0) AS accuracy
    FROM sigma_pod_performance
    WHERE evaluated_at >= NOW() - INTERVAL '#{days} days'
    GROUP BY pod_name
    ORDER BY accuracy DESC NULLS LAST
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Map.new(rows, fn [pod, total, acc] ->
          {pod, %{accuracy: to_float(acc), total: to_int(total)}}
        end)

      _ -> %{}
    end
  rescue
    _ -> %{}
  end

  # ─────────────────────────────────────────────────
  # Private
  # ─────────────────────────────────────────────────

  defp get_baseline(pod_name) do
    sql = """
    SELECT AVG(accuracy)::float AS baseline
    FROM sigma_pod_performance
    WHERE pod_name = $1 AND evaluated_at < NOW() - INTERVAL '7 days'
      AND evaluated_at >= NOW() - INTERVAL '30 days'
    """

    case Jay.Core.Repo.query(sql, [pod_name]) do
      {:ok, %{rows: [[baseline]]}} -> to_float(baseline)
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end

  defp update_ucb_score(pod_name, accuracy, total) do
    try do
      Sigma.V2.AgentSelector.update_score(pod_name, accuracy, total)
    rescue
      _ -> :ok
    end
  end

  defp to_int(nil), do: 0
  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_float(v), do: round(v)
  defp to_int(_), do: 0

  defp to_float(nil), do: 0.0
  defp to_float(v) when is_float(v), do: Float.round(v, 4)
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> 0.0
    end
  end
  defp to_float(_), do: 0.0
end
