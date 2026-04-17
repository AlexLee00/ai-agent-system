defmodule Darwin.V2.ShadowCompare do
  @moduledoc """
  다윈 V2 Shadow 비교 로직 — 순수 함수 모듈 (GenServer 없음).

  V1(TeamJay.Darwin) vs V2(Darwin.V2) 평가 결과를 비교하여
  Jaccard 유사도, 점수 일치율, 판정 불일치를 계산한다.

  참조: Darwin V2 CODEX_DARWIN_REMODEL Phase 6
  """

  @promotion_min_runs   20
  @promotion_min_days   7
  @promotion_min_match  0.95

  @doc """
  Jaccard 유사도 계산.

  두 MapSet(또는 리스트)의 교집합 / 합집합.
  둘 다 비어 있으면 1.0(완전 일치).
  """
  @spec jaccard_similarity(Enumerable.t(), Enumerable.t()) :: float()
  def jaccard_similarity(set_a, set_b) do
    a = MapSet.new(set_a)
    b = MapSet.new(set_b)
    intersection = MapSet.intersection(a, b) |> MapSet.size()
    union        = MapSet.union(a, b)        |> MapSet.size()

    if union == 0, do: 1.0, else: Float.round(intersection / union, 4)
  end

  @doc """
  점수 일치 여부. 기본 허용 오차 ±1.0 (10점 스케일).
  """
  @spec score_match?(number(), number(), number()) :: boolean()
  def score_match?(v1_score, v2_score, tolerance \\ 1.0)
      when is_number(v1_score) and is_number(v2_score) do
    abs(v1_score - v2_score) <= tolerance
  end

  def score_match?(_, _, _), do: false

  @doc """
  전체 비교 리포트 생성.

  v1_result / v2_result 는 다음 형태를 기대:
  ```
  %{
    papers: [%{url: "...", score: 7, verdict: :accept}],
    ...
  }
  ```

  반환값:
  ```
  %{
    match_score: float,
    paper_overlap: float,
    score_differences: [{url, v1_score, v2_score}],
    verdict_differences: [{url, v1_verdict, v2_verdict}],
    summary: string
  }
  ```
  """
  @spec compare(map(), map()) :: map()
  def compare(v1_result, v2_result) do
    v1_papers = papers_map(v1_result)
    v2_papers = papers_map(v2_result)

    v1_urls = MapSet.new(Map.keys(v1_papers))
    v2_urls = MapSet.new(Map.keys(v2_papers))

    paper_overlap = jaccard_similarity(v1_urls, v2_urls)
    common_urls   = MapSet.intersection(v1_urls, v2_urls) |> MapSet.to_list()

    {score_diffs, verdict_diffs, match_count} =
      Enum.reduce(common_urls, {[], [], 0}, fn url, {sdiffs, vdiffs, matches} ->
        p1 = Map.get(v1_papers, url, %{})
        p2 = Map.get(v2_papers, url, %{})

        s1 = p1[:score]
        s2 = p2[:score]
        ve1 = p1[:verdict]
        ve2 = p2[:verdict]

        sdiffs2 = if is_number(s1) and is_number(s2) and not score_match?(s1, s2),
                    do: [{url, s1, s2} | sdiffs],
                    else: sdiffs

        vdiffs2 = if ve1 != nil and ve2 != nil and ve1 != ve2,
                    do: [{url, ve1, ve2} | vdiffs],
                    else: vdiffs

        matched = (is_number(s1) and is_number(s2) and score_match?(s1, s2)) or
                  (s1 == nil and s2 == nil)

        {sdiffs2, vdiffs2, if(matched, do: matches + 1, else: matches)}
      end)

    total_compared = length(common_urls)
    match_score =
      if total_compared == 0,
        do: paper_overlap,
        else: Float.round(match_count / total_compared, 4)

    summary = build_summary(match_score, paper_overlap, length(score_diffs), length(verdict_diffs), total_compared)

    %{
      match_score:         match_score,
      paper_overlap:       paper_overlap,
      score_differences:   Enum.reverse(score_diffs),
      verdict_differences: Enum.reverse(verdict_diffs),
      summary:             summary
    }
  end

  @doc """
  여러 Shadow 실행 결과를 집계.

  `shadow_runs` 는 DB 조회 결과 목록:
  ```
  [%{match_score: float, run_date: Date.t()}, ...]
  ```

  반환:
  ```
  %{
    avg_match: float,
    trend: :improving | :stable | :degrading,
    promotion_ready: bool
  }
  ```
  """
  @spec aggregate_runs([map()]) :: map()
  def aggregate_runs([]), do: %{avg_match: 0.0, trend: :stable, promotion_ready: false}

  def aggregate_runs(shadow_runs) do
    scores = shadow_runs
             |> Enum.map(& &1[:match_score] || &1["match_score"])
             |> Enum.filter(&is_number/1)

    avg_match =
      if scores == [],
        do: 0.0,
        else: Float.round(Enum.sum(scores) / length(scores), 4)

    trend = compute_trend(scores)

    dates =
      shadow_runs
      |> Enum.map(& &1[:run_date] || &1["run_date"])
      |> Enum.filter(& &1 != nil)
      |> Enum.uniq()

    promotion_ready =
      avg_match >= @promotion_min_match and
      length(shadow_runs) >= @promotion_min_runs and
      length(dates) >= @promotion_min_days

    %{
      avg_match:        avg_match,
      trend:            trend,
      promotion_ready:  promotion_ready
    }
  end

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

  # papers_map/1: 결과에서 {url => %{score, verdict}} 맵 추출
  defp papers_map(%{papers: papers}) when is_list(papers) do
    Map.new(papers, fn p ->
      url = p[:url] || p["url"] || inspect(p)
      {url, %{score: p[:score] || p["score"], verdict: p[:verdict] || p["verdict"]}}
    end)
  end

  defp papers_map(_), do: %{}

  # compute_trend/1: 점수 리스트로 추세 계산
  defp compute_trend(scores) when length(scores) < 4, do: :stable

  defp compute_trend(scores) do
    half       = div(length(scores), 2)
    first_half = Enum.take(scores, half)
    last_half  = Enum.drop(scores, half)

    avg = fn list -> Enum.sum(list) / length(list) end

    diff = avg.(last_half) - avg.(first_half)

    cond do
      diff >  0.02 -> :improving
      diff < -0.02 -> :degrading
      true         -> :stable
    end
  end

  # build_summary/5
  defp build_summary(match_score, paper_overlap, score_diffs, verdict_diffs, total) do
    status =
      cond do
        match_score >= @promotion_min_match -> "승격 조건 충족"
        match_score >= 0.80                -> "준수"
        true                               -> "불일치 다수"
      end

    "match=#{Float.round(match_score * 100, 1)}% overlap=#{Float.round(paper_overlap * 100, 1)}% " <>
    "비교=#{total}건 score_diff=#{score_diffs}건 verdict_diff=#{verdict_diffs}건 [#{status}]"
  end
end
