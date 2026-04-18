defmodule Darwin.V2.ResearchRegistry do
  @moduledoc """
  다윈팀 Research Registry — Phase R2 구현.

  논문을 단순 데이터가 아닌 "라이프사이클을 갖는 운영 객체"로 관리:
    discovered → evaluated → planned → implemented → verified → applied → measured → retired

  핵심 기능:
  - register_paper/1    — 신규 논문 등록 (DISCOVER 단계)
  - transition/3        — 단계 전이 기록
  - link_effect/2       — 논문 → 구현 효과 링크
  - record_cycle_result/1 — 사이클 결과로 Registry 갱신
  - refresh_effects/0   — 주간 효과 재계산 (MapeKLoop 호출)

  불변 원칙:
  - 삭제 금지 (retired 상태로만 처리)
  - 단계 역행 금지 (discovered → applied 직행 불가)

  Kill Switch: DARWIN_RESEARCH_REGISTRY_ENABLED=true
  """

  require Logger

  @stages ~w(discovered evaluated planned implemented verified applied measured retired)

  @valid_transitions %{
    "discovered"    => ~w(evaluated retired),
    "evaluated"     => ~w(planned retired),
    "planned"       => ~w(implemented retired),
    "implemented"   => ~w(verified retired),
    "verified"      => ~w(applied retired),
    "applied"       => ~w(measured retired),
    "measured"      => ~w(retired),
    "retired"       => []
  }

  # ─────────────────────────────────────────────────
  # 공개 API
  # ─────────────────────────────────────────────────

  @doc "신규 논문 등록 (DISCOVER 단계)."
  @spec register_paper(map()) :: :ok
  def register_paper(paper) do
    unless enabled?(), do: (Logger.debug("[Darwin.V2.ResearchRegistry] kill switch OFF"); :ok)

    sql = """
    INSERT INTO darwin_research_registry
      (paper_id, title, authors, source, url, discovered_at, stage, keywords, metadata, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), 'discovered', $6, $7, NOW())
    ON CONFLICT (paper_id) DO NOTHING
    """

    paper_id = paper[:arxiv_id] || paper[:id] || paper["arxiv_id"] || paper["id"] || generate_id(paper)
    authors = paper[:authors] || paper["authors"] || []
    keywords = paper[:keywords] || paper["keywords"] || []
    metadata = (paper[:metadata] || paper["metadata"] || %{}) |> Jason.encode!()

    Jay.Core.Repo.query(sql, [
      to_string(paper_id),
      paper[:title] || paper["title"] || "Unknown",
      Enum.map(authors, &to_string/1),
      to_string(paper[:source] || paper["source"] || "unknown"),
      to_string(paper[:url] || paper["url"] || ""),
      keywords,
      metadata
    ])

    Logger.info("[Darwin.V2.ResearchRegistry] 논문 등록: #{paper_id}")
    :ok
  rescue
    e ->
      Logger.warning("[Darwin.V2.ResearchRegistry] register_paper 오류: #{inspect(e)}")
      :ok
  end

  @doc "단계 전이 기록. 유효하지 않은 전이는 거부됨."
  @spec transition(String.t(), String.t(), map()) :: {:ok, String.t()} | {:error, term()}
  def transition(paper_id, to_stage, metadata \\ %{}) do
    unless to_stage in @stages do
      {:error, {:invalid_stage, to_stage}}
    else
      do_transition(paper_id, to_stage, metadata)
    end
  end

  @doc "논문 → 구현 효과 링크 (APPLY 단계 이후)."
  @spec link_effect(String.t(), map()) :: :ok
  def link_effect(paper_id, effect) do
    unless enabled?(), do: :ok

    improvement = calc_improvement(effect[:before_metrics], effect[:after_metrics])

    sql = """
    INSERT INTO darwin_research_effects
      (paper_id, effect_type, target, commit_sha,
       before_metrics, after_metrics, improvement_pct, measured_at, inserted_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, NOW())
    """

    Jay.Core.Repo.query(sql, [
      to_string(paper_id),
      to_string(effect[:type] || "unknown"),
      to_string(effect[:target] || ""),
      to_string(effect[:commit_sha] || ""),
      Jason.encode!(effect[:before_metrics] || %{}),
      Jason.encode!(effect[:after_metrics] || %{}),
      improvement,
      effect[:measured_at] || DateTime.utc_now()
    ])

    Logger.info("[Darwin.V2.ResearchRegistry] 효과 링크: paper_id=#{paper_id}, type=#{effect[:type]}, improvement=#{improvement}%")
    :ok
  rescue
    e ->
      Logger.warning("[Darwin.V2.ResearchRegistry] link_effect 오류: #{inspect(e)}")
      :ok
  end

  @doc "사이클 결과로 Registry 자동 갱신 (MapeKLoop에서 호출)."
  @spec record_cycle_result(map()) :: :ok
  def record_cycle_result(cycle_result) do
    unless enabled?(), do: :ok

    paper_id = cycle_result[:paper_id] || cycle_result[:paper_title]
    stage = cycle_result_to_stage(cycle_result)

    if paper_id && stage do
      transition(to_string(paper_id), stage, %{cycle_id: cycle_result[:cycle_id]})
    end

    :ok
  rescue
    e ->
      Logger.warning("[Darwin.V2.ResearchRegistry] record_cycle_result 오류: #{inspect(e)}")
      :ok
  end

  @doc "주간 효과 재계산 (MapeKLoop에서 일요일 호출)."
  @spec refresh_effects() :: :ok
  def refresh_effects do
    unless enabled?(), do: :ok

    sql = """
    SELECT paper_id FROM darwin_research_registry
    WHERE stage = 'applied'
      AND updated_at > NOW() - INTERVAL '7 days'
    LIMIT 20
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [pid] ->
          Logger.debug("[Darwin.V2.ResearchRegistry] refresh_effects: paper_id=#{pid}")
        end)
        Logger.info("[Darwin.V2.ResearchRegistry] refresh_effects 완료: #{length(rows)}건")

      _ ->
        Logger.debug("[Darwin.V2.ResearchRegistry] refresh_effects — DB 접근 불가 또는 대상 없음")
    end

    :ok
  rescue
    e ->
      Logger.warning("[Darwin.V2.ResearchRegistry] refresh_effects 오류: #{inspect(e)}")
      :ok
  end

  # ─────────────────────────────────────────────────
  # Private
  # ─────────────────────────────────────────────────

  defp enabled?, do: Darwin.V2.KillSwitch.enabled?(:research_registry)

  defp do_transition(paper_id, to_stage, metadata) do
    current = fetch_current_stage(paper_id)

    allowed = Map.get(@valid_transitions, current || "discovered", [])

    if to_stage in allowed do
      update_stage(paper_id, to_stage)
      log_promotion(paper_id, current, to_stage, metadata)
      {:ok, to_stage}
    else
      Logger.warning("[Darwin.V2.ResearchRegistry] 유효하지 않은 전이 거부: #{current} → #{to_stage}")
      {:error, {:invalid_transition, current, to_stage}}
    end
  end

  defp fetch_current_stage(paper_id) do
    case Jay.Core.Repo.query("SELECT stage FROM darwin_research_registry WHERE paper_id = $1 LIMIT 1", [paper_id]) do
      {:ok, %{rows: [[stage]]}} -> stage
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp update_stage(paper_id, stage) do
    Jay.Core.Repo.query(
      "UPDATE darwin_research_registry SET stage = $1, updated_at = NOW() WHERE paper_id = $2",
      [stage, paper_id]
    )
  rescue
    _ -> :ok
  end

  defp log_promotion(paper_id, from_stage, to_stage, metadata) do
    sql = """
    INSERT INTO darwin_research_promotion_log
      (paper_id, from_stage, to_stage, metadata, inserted_at)
    VALUES ($1, $2, $3, $4::jsonb, NOW())
    """

    Jay.Core.Repo.query(sql, [paper_id, from_stage || "unknown", to_stage, Jason.encode!(metadata)])
  rescue
    _ -> :ok
  end

  defp cycle_result_to_stage(result) do
    cond do
      result[:applied] == true -> "applied"
      result[:verification_success] == true -> "verified"
      result[:implementation_success] == true -> "implemented"
      result[:stage] == "learn" -> "evaluated"
      true -> nil
    end
  end

  defp calc_improvement(nil, _), do: 0.0
  defp calc_improvement(_, nil), do: 0.0
  defp calc_improvement(before, after_map) when is_map(before) and is_map(after_map) do
    score_before = Map.get(before, "score") || Map.get(before, :score) || 0
    score_after = Map.get(after_map, "score") || Map.get(after_map, :score) || 0
    if score_before > 0 do
      Float.round((score_after - score_before) / score_before * 100, 2)
    else
      0.0
    end
  end
  defp calc_improvement(_, _), do: 0.0

  defp generate_id(paper) do
    title = paper[:title] || paper["title"] || ""
    :crypto.hash(:md5, title) |> Base.encode16(case: :lower) |> String.slice(0, 12)
  end
end
