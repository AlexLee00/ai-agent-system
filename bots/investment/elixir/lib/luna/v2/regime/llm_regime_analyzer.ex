defmodule Luna.V2.Regime.LLMRegimeAnalyzer do
  @moduledoc """
  Phase 1 — LLM 기반 시장 체제 분석기.

  규칙 기반 체제 감지(market_regime_snapshots) 위에 LLM 컨텍스트 레이어를 추가한다.
  Shadow Mode(기본): 규칙 기반과 병렬 실행 후 luna_regime_llm_shadow에 비교 저장.
  Promotion Gate 통과 후 마스터 명시 시 shadow_mode: false로 LLM 우선 전환 가능.

  입력:
    market       - 분석 마켓 (crypto / domestic / overseas)
    shadow_mode  - true면 비교 저장만 (기본), false면 LLM 결과 우선 반환

  출력:
    %{market, regime, confidence, rationale, duration_estimate, key_signals,
      shadow_mode, rule_regime, match}
  """
  use Jido.Action,
    name: "llm_regime_analyzer",
    description: "LLM으로 시장 체제를 분석합니다. Shadow Mode에서는 규칙 기반 결과와 비교 저장합니다.",
    schema: [
      market:      [type: :string,  required: false, default: "crypto"],
      shadow_mode: [type: :boolean, required: false, default: true]
    ]

  require Logger

  @valid_regimes ~w[trending_bull trending_bear ranging volatile unknown]

  # ─── Public Entry Point ──────────────────────────────────────────

  def run(%{market: market, shadow_mode: shadow_mode}, _context) do
    Logger.info("[루나V2/LLMRegimeAnalyzer] #{market} LLM 체제 분석 시작 (shadow=#{shadow_mode})")

    with {:ok, rule_snapshot} <- fetch_rule_snapshot(market),
         {:ok, llm_result}    <- analyze_with_llm(market, rule_snapshot) do
      if shadow_mode, do: store_shadow(market, rule_snapshot, llm_result)

      match = rule_snapshot.regime == llm_result.regime
      Logger.info("[루나V2/LLMRegimeAnalyzer] 완료 — rule=#{rule_snapshot.regime} llm=#{llm_result.regime} match=#{match}")

      {:ok, llm_result
            |> Map.put(:market, market)
            |> Map.put(:shadow_mode, shadow_mode)
            |> Map.put(:rule_regime, rule_snapshot.regime)
            |> Map.put(:match, match)}
    else
      {:error, reason} ->
        Logger.warning("[루나V2/LLMRegimeAnalyzer] 분석 실패: #{inspect(reason)}")
        {:ok, %{market: market, regime: "unknown", shadow_mode: shadow_mode, error: inspect(reason)}}
    end
  end

  # ─── Rule Snapshot Fetch ─────────────────────────────────────────

  defp fetch_rule_snapshot(market) do
    query = """
    SELECT regime, confidence, indicators, captured_at
    FROM investment.market_regime_snapshots
    WHERE market = $1
    ORDER BY captured_at DESC
    LIMIT 1
    """
    case Jay.Core.Repo.query(query, [market]) do
      {:ok, %{rows: [[regime, confidence, indicators, captured_at] | _]}} ->
        {:ok, %{
          regime:      regime || "unknown",
          confidence:  to_float(confidence, 0.5),
          indicators:  indicators || %{},
          captured_at: captured_at
        }}
      {:ok, %{rows: []}} ->
        {:ok, %{regime: "unknown", confidence: 0.5, indicators: %{}, captured_at: nil}}
      {:error, reason} ->
        {:error, {:fetch_snapshot_failed, reason}}
    end
  end

  # ─── LLM Analysis ────────────────────────────────────────────────

  defp analyze_with_llm(market, rule_snapshot) do
    prompt = build_prompt(market, rule_snapshot)
    case Luna.V2.LLM.Selector.call_with_fallback(
           "luna.regime.analyzer",
           prompt,
           urgency: :low,
           task_type: :regime_analysis,
           max_tokens: 600
         ) do
      {:ok, content} -> parse_llm_response(content)
      {:error, reason} -> {:error, {:llm_failed, reason}}
    end
  end

  defp build_prompt(market, rule_snapshot) do
    market_kr        = market_kr_name(market)
    indicators_text  = format_indicators(rule_snapshot.indicators)
    rule_conf_pct    = Float.round(rule_snapshot.confidence * 100.0, 1)

    """
    당신은 #{market_kr} 시장 체제 판단 전문가다.
    다음 정보를 종합하여 현재 시장 체제를 판단하라.

    [규칙 기반 현재 판단]
    체제: #{rule_snapshot.regime}
    신뢰도: #{rule_conf_pct}%

    [시장 데이터]
    #{indicators_text}

    [체제 분류 기준]
    - trending_bull: 강한 상승 추세, 고신뢰 양봉 지속
    - trending_bear: 강한 하락 추세, 고신뢰 음봉 지속
    - ranging: 방향성 없는 횡보장
    - volatile: 급격한 변동성 (극단적 가격 변동)

    [응답 형식 — 반드시 JSON만 출력, 코드블록 없이]
    {"regime":"trending_bull","confidence":75,"rationale":"한 문장 근거","duration_estimate":"단기(1-3일)","key_signals":["신호1","신호2"]}
    """
  end

  defp format_indicators(%{"snapshots" => snapshots}) when is_list(snapshots) and snapshots != [] do
    snapshots
    |> Enum.take(5)
    |> Enum.map_join("\n", fn s ->
      label      = Map.get(s, "label", Map.get(s, "symbol", "?"))
      day_change = to_float(Map.get(s, "dayChangePct", 0.0), 0.0)
      "- #{label}: 일간 #{Float.round(day_change, 2)}%"
    end)
  end
  defp format_indicators(%{"avgAbsDayChange" => avg}) do
    "평균 일간 변동: #{Float.round(to_float(avg, 0.0), 2)}%"
  end
  defp format_indicators(_), do: "지표 데이터 없음"

  # ─── Response Parsing ─────────────────────────────────────────────

  defp parse_llm_response(content) do
    json_str = extract_json(content)
    case Jason.decode(json_str) do
      {:ok, %{"regime" => regime} = parsed} when regime in @valid_regimes ->
        {:ok, %{
          regime:            regime,
          confidence:        min(max(to_float(parsed["confidence"], 50.0) / 100.0, 0.0), 1.0),
          rationale:         Map.get(parsed, "rationale", ""),
          duration_estimate: Map.get(parsed, "duration_estimate", "단기"),
          key_signals:       Map.get(parsed, "key_signals", [])
        }}
      {:ok, %{"regime" => invalid}} ->
        {:error, {:invalid_regime, invalid}}
      {:error, _} ->
        {:error, {:parse_failed, String.slice(content, 0, 200)}}
    end
  end

  defp extract_json(content) do
    # 코드블록 제거 후 첫 번째 JSON 객체 추출
    cleaned = Regex.replace(~r/```(?:json)?\s*/, content, "")
    case Regex.run(~r/\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/s, cleaned) do
      [json | _] -> json
      nil        -> content
    end
  end

  # ─── Shadow Storage ───────────────────────────────────────────────

  defp store_shadow(market, rule_snapshot, llm_result) do
    query = """
    INSERT INTO investment.luna_regime_llm_shadow
      (market, rule_regime, rule_confidence, llm_regime, llm_confidence,
       llm_rationale, llm_duration, llm_key_signals)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    """
    params = [
      market,
      rule_snapshot.regime,
      rule_snapshot.confidence,
      llm_result.regime,
      llm_result.confidence,
      llm_result.rationale,
      llm_result.duration_estimate,
      Jason.encode!(llm_result.key_signals)
    ]
    case Jay.Core.Repo.query(query, params) do
      {:ok, _}         -> :ok
      {:error, reason} ->
        Logger.warning("[루나V2/LLMRegimeAnalyzer] Shadow 저장 실패: #{inspect(reason)}")
    end
  end

  # ─── Helpers ──────────────────────────────────────────────────────

  defp market_kr_name("crypto"),   do: "암호화폐"
  defp market_kr_name("domestic"), do: "국내 주식"
  defp market_kr_name("overseas"), do: "해외 주식"
  defp market_kr_name(market),     do: market

  defp to_float(%Decimal{} = d, _default), do: Decimal.to_float(d)
  defp to_float(v, _default) when is_float(v), do: v
  defp to_float(v, _default) when is_integer(v), do: v * 1.0
  defp to_float(_, default), do: default
end
