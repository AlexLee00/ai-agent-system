defmodule Darwin.V2.HypothesisEngine do
  @moduledoc """
  다윈팀 V2 Hypothesis Engine — Sakana AI Scientist 패턴 통합.

  7단계 사이클을 8단계로 확장:
    DISCOVER → HYPOTHESIZE → EVALUATE → PLAN →
    IMPLEMENT → VERIFY → APPLY → LEARN

  ## 핵심 기능
  - generate/2          논문 + 코드베이스 컨텍스트 → Hypothesis 카드 생성
  - list_pending/0      pending 상태 가설 목록
  - update_status/3     상태 전이 (pending→testing→confirmed|refuted)
  - confirmed_patterns/1 confirmed 가설에서 우선 검색 패턴 추출

  ## DB: darwin_hypotheses 테이블
  - status: pending | testing | confirmed | refuted

  Kill Switch: DARWIN_HYPOTHESIS_ENGINE_ENABLED=true
  LLM 비용 상한: DARWIN_HYPOTHESIS_LLM_DAILY_BUDGET_USD (기본 2.0)
  """

  require Logger
  alias Jay.Core.Repo

  @valid_statuses ~w(pending testing confirmed refuted)

  # ────────────────────────────────────────────────
  # Public API
  # ────────────────────────────────────────────────

  @doc """
  논문과 코드베이스 컨텍스트를 바탕으로 Hypothesis 카드를 생성하고 DB 저장.

  ## Sakana AI Scientist 패턴
    "이 논문 [X]를 우리 [Y 모듈]에 적용하면 [Z 메트릭]이 [+delta] 개선될 것이다"

  Returns: {:ok, hypothesis_id} | {:skip, :disabled} | {:error, term()}
  """
  @spec generate(map(), keyword()) :: {:ok, integer()} | {:skip, :disabled} | {:error, term()}
  def generate(paper, opts \\ []) do
    if enabled?() do
      do_generate(paper, opts)
    else
      Logger.debug("[darwin/hypothesis_engine] 비활성 — 생성 건너뜀")
      {:skip, :disabled}
    end
  end

  @doc "pending 상태 가설 목록 반환."
  @spec list_pending() :: [map()]
  def list_pending do
    list_by_status("pending")
  end

  @doc "testing 상태 가설 목록 반환."
  @spec list_testing() :: [map()]
  def list_testing do
    list_by_status("testing")
  end

  @doc """
  가설 상태 전이.

  valid: pending→testing, testing→confirmed, testing→refuted
  test_result: 실제 측정 결과 (metric, before, after, delta)
  """
  @spec update_status(integer(), String.t(), map()) :: :ok | {:error, term()}
  def update_status(hypothesis_id, new_status, test_result \\ %{}) do
    unless new_status in @valid_statuses do
      {:error, {:invalid_status, new_status}}
    else
      sql = """
      UPDATE darwin_hypotheses
      SET status = $2, test_result = $3, measured_at = NOW()
      WHERE id = $1
      """

      case Repo.query(sql, [hypothesis_id, new_status, test_result]) do
        {:ok, _} ->
          Logger.info("[darwin/hypothesis_engine] 가설 상태 전이 id=#{hypothesis_id} → #{new_status}")
          :ok

        {:error, reason} ->
          Logger.error("[darwin/hypothesis_engine] update_status 실패: #{inspect(reason)}")
          {:error, reason}
      end
    end
  rescue
    e -> {:error, e}
  end

  @doc """
  confirmed 가설에서 다음 cycle 우선 검색 패턴 추출.
  Commander.plan_pipeline에서 활용.
  """
  @spec confirmed_patterns(String.t() | nil) :: [map()]
  def confirmed_patterns(target_team \\ nil) do
    sql =
      if target_team do
        """
        SELECT source_paper_id, target_team, target_module,
               expected_metric, expected_delta, confidence
        FROM darwin_hypotheses
        WHERE status = 'confirmed' AND target_team = $1
        ORDER BY confidence DESC
        LIMIT 20
        """
      else
        """
        SELECT source_paper_id, target_team, target_module,
               expected_metric, expected_delta, confidence
        FROM darwin_hypotheses
        WHERE status = 'confirmed'
        ORDER BY confidence DESC
        LIMIT 20
        """
      end

    params = if target_team, do: [target_team], else: []

    case Repo.query(sql, params) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row ->
          cols
          |> Enum.map(&String.to_atom/1)
          |> Enum.zip(row)
          |> Map.new()
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  @doc "refuted 가설 목록 — Reflexion 통합에서 회피 패턴으로 활용."
  @spec refuted_patterns() :: [String.t()]
  def refuted_patterns do
    sql = """
    SELECT hypothesis_text
    FROM darwin_hypotheses
    WHERE status = 'refuted'
    ORDER BY inserted_at DESC
    LIMIT 50
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: rows}} -> Enum.map(rows, fn [text] -> text end)
      _ -> []
    end
  rescue
    _ -> []
  end

  # ────────────────────────────────────────────────
  # Private — 생성 로직
  # ────────────────────────────────────────────────

  defp do_generate(paper, opts) do
    target_team = Keyword.get(opts, :target_team)
    codebase_context = Keyword.get(opts, :codebase_context, build_default_context(target_team))

    paper_title = paper[:title] || paper["title"] || "unknown"
    paper_id = paper[:arxiv_id] || paper["arxiv_id"] || paper[:id] || paper["id"] || ""
    abstract = paper[:abstract] || paper["abstract"] || ""

    # refuted 패턴으로 회피 컨텍스트
    refuted = refuted_patterns() |> Enum.take(5) |> Enum.join("\n- ")

    prompt = """
    당신은 Sakana AI Scientist 역할입니다. 다음 논문을 우리 ai-agent-system 코드베이스에
    적용했을 때 검증 가능한 가설(Hypothesis)을 생성하세요.

    ## 논문
    제목: #{paper_title}
    arXiv ID: #{paper_id}
    초록: #{String.slice(abstract, 0, 500)}

    ## 적용 대상 컨텍스트
    #{codebase_context}

    ## 과거 실패 패턴 (피해야 할 접근)
    #{if refuted == "", do: "없음", else: "- #{refuted}"}

    ## 가설 형식
    반드시 다음 JSON 형식으로 하나의 가설을 작성하세요:
    {
      "target_team": "팀명 (luna/blog/ska/worker/video/justin/sigma/hub/jay/darwin)",
      "target_module": "구체적 모듈/파일 경로",
      "hypothesis_text": "이 논문 [X]를 [target_module]에 적용하면 [expected_metric]이 [expected_delta] 개선될 것이다",
      "expected_metric": "측정 가능한 지표 (예: win_rate, latency_ms, f1_score)",
      "expected_delta": 0.05,
      "confidence": 0.7
    }

    가설은 반드시:
    1. Testable (24h/7d/30d 내 측정 가능)
    2. Falsifiable (수치로 기각 가능)
    3. Specific (구체적 모듈 + 지표 명시)
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("darwin.commander", prompt,
           max_tokens: 500,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: text}} ->
        parse_and_save_hypothesis(text, paper_id, target_team)

      {:error, reason} ->
        Logger.error("[darwin/hypothesis_engine] LLM 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp parse_and_save_hypothesis(text, paper_id, _override_team) do
    with {:ok, json} <- extract_json(text),
         {:ok, data} <- Jason.decode(json) do
      sql = """
      INSERT INTO darwin_hypotheses
        (source_paper_id, target_team, target_module, hypothesis_text,
         expected_metric, expected_delta, confidence, status, inserted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      RETURNING id
      """

      params = [
        paper_id,
        data["target_team"] || "darwin",
        data["target_module"] || "",
        data["hypothesis_text"] || "",
        data["expected_metric"] || "",
        parse_decimal(data["expected_delta"]),
        parse_decimal(data["confidence"])
      ]

      case Repo.query(sql, params) do
        {:ok, %{rows: [[id]]}} ->
          Logger.info("[darwin/hypothesis_engine] 가설 생성 id=#{id} team=#{data["target_team"]}")
          {:ok, id}

        {:error, reason} ->
          {:error, reason}
      end
    else
      _ ->
        Logger.warning("[darwin/hypothesis_engine] JSON 파싱 실패 — text=#{String.slice(text, 0, 200)}")
        {:error, :parse_failed}
    end
  end

  defp list_by_status(status) do
    sql = """
    SELECT id, source_paper_id, target_team, target_module,
           hypothesis_text, expected_metric, expected_delta, confidence,
           status, test_result, inserted_at, measured_at
    FROM darwin_hypotheses
    WHERE status = $1
    ORDER BY confidence DESC, inserted_at DESC
    LIMIT 50
    """

    case Repo.query(sql, [status]) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row ->
          cols
          |> Enum.map(&String.to_atom/1)
          |> Enum.zip(row)
          |> Map.new()
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp build_default_context(nil) do
    """
    ai-agent-system 팀 구조:
    - luna: 자동매매 (crypto live, 국내외 mock)
    - blog: 네이버 블로그 자동화
    - ska: 스터디카페 예약/매출 관리
    - worker: 비즈니스 관리 SaaS
    - video: 영상 자동편집/자동생성
    - sigma: RAG 대도서관 + 팀간 지식 연결
    - hub: 오케스트레이션 허브
    - darwin: R&D 자율 연구 센터
    """
  end

  defp build_default_context(team) do
    "target_team: #{team}\n" <> build_default_context(nil)
  end

  defp extract_json(text) do
    cond do
      Regex.match?(~r/```json\s*(\{.+\})\s*```/s, text) ->
        [_, json] = Regex.run(~r/```json\s*(\{.+\})\s*```/s, text)
        {:ok, json}

      Regex.match?(~r/```\s*(\{.+\})\s*```/s, text) ->
        [_, json] = Regex.run(~r/```\s*(\{.+\})\s*```/s, text)
        {:ok, json}

      Regex.match?(~r/\{.+\}/s, text) ->
        [json] = Regex.run(~r/\{.+\}/s, text)
        {:ok, json}

      true ->
        {:error, :no_json}
    end
  end

  defp parse_decimal(nil), do: nil
  defp parse_decimal(v) when is_float(v), do: v
  defp parse_decimal(v) when is_integer(v), do: v * 1.0
  defp parse_decimal(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> nil
    end
  end
  defp parse_decimal(_), do: nil

  defp enabled? do
    System.get_env("DARWIN_HYPOTHESIS_ENGINE_ENABLED") == "true"
  end
end
