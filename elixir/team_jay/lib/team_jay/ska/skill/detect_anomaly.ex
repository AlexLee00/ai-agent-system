defmodule TeamJay.Ska.Skill.DetectAnomaly do
  @moduledoc """
  시계열 이상 감지 스킬.

  매출/예약 수/키오스크 사용률 등 시계열 데이터에서 이상치를 탐지.
  기존 ExceptionDetector(419줄)의 순수 함수 부분을 스킬화.

  방법:
  - :z_score  — 평균 ± 3σ 이탈
  - :iqr      — IQR × 1.5 이탈
  - :prophet_residual — Prophet 예측 잔차 기반 (Python 경유)

  입력: %{metric_name: "daily_revenue", values: [1.0, 2.0, ...], method: :z_score}
  출력: {:ok, %{anomalies: list, score: float, method_used: atom}}
  """
  @behaviour TeamJay.Ska.Skill
  require Logger

  @impl true
  def metadata do
    %{
      name: :detect_anomaly,
      domain: :analytics,
      version: "1.0",
      description: "시계열 이상치 감지 (Z-score / IQR / Prophet residual)",
      input_schema: %{metric_name: :string, values: :list, method: :atom, threshold: :float},
      output_schema: %{anomalies: :list, score: :float, method_used: :atom}
    }
  end

  @impl true
  def run(params, _context) do
    values = params[:values] || []
    method = params[:method] || :z_score
    threshold = params[:threshold] || 3.0

    if values == [] do
      {:ok, %{anomalies: [], score: 0.0, method_used: method}}
    else
      anomalies =
        case method do
          :z_score -> detect_z_score(values, threshold)
          :iqr -> detect_iqr(values, threshold)
          :prophet_residual -> detect_prophet_residual(values, threshold, params)
          _ -> []
        end

      {:ok, %{anomalies: anomalies, score: anomaly_score(anomalies, values), method_used: method}}
    end
  end

  @impl true
  def health_check, do: :ok

  # ─── 감지 로직 ────────────────────────────────────────────

  defp detect_z_score(values, threshold) do
    n = length(values)
    mean = Enum.sum(values) / n
    variance = Enum.reduce(values, 0.0, fn v, acc -> acc + :math.pow(v - mean, 2) end) / n
    stddev = :math.sqrt(variance)

    if stddev == 0.0 do
      []
    else
      values
      |> Enum.with_index()
      |> Enum.filter(fn {v, _i} -> abs(v - mean) / stddev > threshold end)
      |> Enum.map(fn {v, i} ->
        %{index: i, value: v, deviation: Float.round(abs(v - mean) / stddev, 3)}
      end)
    end
  end

  defp detect_iqr(values, multiplier) do
    sorted = Enum.sort(values)
    n = length(sorted)
    q1 = Enum.at(sorted, div(n, 4))
    q3 = Enum.at(sorted, div(n * 3, 4))
    iqr = q3 - q1
    lower = q1 - multiplier * iqr
    upper = q3 + multiplier * iqr

    values
    |> Enum.with_index()
    |> Enum.filter(fn {v, _} -> v < lower or v > upper end)
    |> Enum.map(fn {v, i} ->
      %{index: i, value: v, deviation: if(v < lower, do: lower - v, else: v - upper)}
    end)
  end

  defp detect_prophet_residual(values, threshold, params) do
    unless System.get_env("SKA_PYTHON_SKILL_ENABLED", "false") == "true" do
      Logger.debug("[DetectAnomaly] Prophet 모드: SKA_PYTHON_SKILL_ENABLED=false → z_score fallback")
      detect_z_score(values, threshold)
    else
      metric = params[:metric_name] || "unknown"

      case TeamJay.Ska.PortBridge.PythonPort.call("forecast.py", %{
             action: "detect_anomaly",
             metric_name: metric,
             values: values,
             threshold: threshold
           }) do
        {:ok, %{"anomalies" => anomalies}} ->
          anomalies

        {:error, _reason} ->
          Logger.warning("[DetectAnomaly] Prophet 이상감지 실패 → z_score fallback")
          detect_z_score(values, threshold)
      end
    end
  end

  defp anomaly_score(anomalies, values) do
    if values == [], do: 0.0, else: length(anomalies) / length(values)
  end
end
