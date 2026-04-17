defmodule Darwin.V2.MetaReview do
  @moduledoc """
  다윈 V2 메타 리뷰 — 주간 종합 성과 분석 + 전략 개선.

  역할:
  - 매주 일요일 밤 자동 실행 (7일 주기 Process.send_after)
  - 지난 주 연구 사이클 분석
  - 개선 권고사항 생성
  - Memory.L2를 통한 Commander 전략 업데이트
  - 활성화된 경우 ESPL 진화 트리거

  리뷰 섹션:
    1. 파이프라인 메트릭 (FeedbackLoop 통계)
    2. LLM 비용 분석 (CostTracker)
    3. 키워드 효과성 (KeywordEvolver)
    4. 자율 레벨 진행 상황
    5. Shadow 모드 비교 (shadow 모드 시)
    6. 다음 주 권고사항

  DB: darwin_v2_pipeline_audit (stage = 'meta_review')
  """

  use GenServer
  require Logger

  alias Darwin.V2.{FeedbackLoop, KeywordEvolver, ResearchMonitor, ESPL}
  alias TeamJay.HubClient

  @review_interval_ms 7 * 24 * 60 * 60 * 1000  # 7일

  defstruct [
    last_review:     nil,
    review_count:    0,
    last_review_at:  nil
  ]

  # ──────────────────────────────────────────────
  # 공개 API
  # ──────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 메타 리뷰 실행 (수동 트리거)."
  @spec run_review() :: {:ok, map()} | {:error, term()}
  def run_review do
    GenServer.call(__MODULE__, :run_review, 120_000)
  end

  @doc "마지막 리뷰 요약 반환."
  @spec last_review() :: map() | nil
  def last_review do
    GenServer.call(__MODULE__, :last_review)
  end

  # ──────────────────────────────────────────────
  # GenServer 콜백
  # ──────────────────────────────────────────────

  @impl GenServer
  def init(_opts) do
    # 다음 일요일 밤까지 대기 (또는 7일 주기)
    Process.send_after(self(), :weekly_review, @review_interval_ms)
    Logger.info("[다윈V2 메타리뷰] 시작! 다음 리뷰: #{format_next_review()}")
    {:ok, %__MODULE__{}}
  end

  @impl GenServer
  def handle_info(:weekly_review, state) do
    Logger.info("[다윈V2 메타리뷰] 주간 자동 리뷰 시작...")
    new_state = do_review(state)
    Process.send_after(self(), :weekly_review, @review_interval_ms)
    {:noreply, new_state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_call(:run_review, _from, state) do
    new_state = do_review(state)
    result =
      case new_state.last_review do
        nil -> {:error, :review_failed}
        review -> {:ok, review}
      end

    {:reply, result, new_state}
  end

  def handle_call(:last_review, _from, state) do
    {:reply, state.last_review, state}
  end

  # ──────────────────────────────────────────────
  # 내부 — 리뷰 실행
  # ──────────────────────────────────────────────

  defp do_review(state) do
    Logger.info("[다윈V2 메타리뷰] 데이터 수집 중...")

    with {:ok, sections} <- collect_review_sections(),
         {:ok, summary}  <- generate_review_summary(sections) do
      review = %{
        date:            Date.utc_today(),
        summary:         summary,
        recommendations: extract_recommendations(summary),
        sections:        sections,
        created_at:      DateTime.utc_now()
      }

      # L2 장기 메모리에 저장
      Task.start(fn -> store_in_memory(review) end)

      # DB에 저장
      Task.start(fn -> persist_review(review) end)

      # JayBus 브로드캐스트
      Task.start(fn -> broadcast_review(review) end)

      # ESPL 진화 트리거 (활성화 시)
      if Application.get_env(:darwin, :espl_enabled, false) do
        Task.start(fn -> trigger_espl_evolution(sections) end)
      end

      Logger.info("[다윈V2 메타리뷰] 리뷰 완료 — #{length(review.recommendations)}개 권고사항")

      %{state |
        last_review:    review,
        review_count:   state.review_count + 1,
        last_review_at: DateTime.utc_now()
      }
    else
      {:error, reason} ->
        Logger.error("[다윈V2 메타리뷰] 리뷰 실패: #{inspect(reason)}")
        state
    end
  end

  # ──────────────────────────────────────────────
  # 내부 — 섹션 데이터 수집
  # ──────────────────────────────────────────────

  defp collect_review_sections do
    pipeline_stats = FeedbackLoop.pipeline_stats()
    kpis           = ResearchMonitor.get_kpis()
    health         = ResearchMonitor.get_health()
    top_keywords   = KeywordEvolver.get_top_keywords(10)
    recent_failures = FeedbackLoop.recent_failures(5)
    llm_cost       = Map.get(kpis, :daily_llm_cost_usd, 0.0)
    autonomy_level = Map.get(kpis, :autonomy_level, 1)

    # 7일 주간 DB 통계
    {:ok, weekly_stats} = fetch_weekly_db_stats()

    sections = %{
      pipeline: %{
        total:          pipeline_stats[:total]       || 0,
        evaluated:      pipeline_stats[:evaluated]   || 0,
        implemented:    pipeline_stats[:implemented] || 0,
        verified:       pipeline_stats[:verified]    || 0,
        applied:        pipeline_stats[:applied]     || 0,
        health:         health,
        recent_failures: recent_failures
      },
      llm_cost: %{
        daily_usd:  llm_cost,
        weekly_usd: weekly_stats.llm_cost_7d,
        budget:     System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0") |> String.to_float()
      },
      keywords: %{
        top:    top_keywords,
        total:  length(KeywordEvolver.get_keywords())
      },
      autonomy: %{
        level:               autonomy_level,
        papers_applied_7d:   Map.get(kpis, :papers_applied_7d, 0),
        papers_verified_7d:  Map.get(kpis, :papers_verified_7d, 0),
        avg_score_7d:        Map.get(kpis, :avg_score_7d, 0.0)
      },
      shadow: collect_shadow_stats()
    }

    {:ok, sections}
  rescue
    e ->
      Logger.error("[다윈V2 메타리뷰] 섹션 수집 실패: #{Exception.message(e)}")
      {:error, Exception.message(e)}
  end

  defp fetch_weekly_db_stats do
    sql = """
    SELECT
      COUNT(*) FILTER (WHERE stage = 'applied')::int          AS applied_7d,
      COUNT(*) FILTER (WHERE stage = 'verification_failed')::int AS failed_7d,
      COALESCE(AVG(score) FILTER (WHERE score IS NOT NULL), 0)::float AS avg_score
    FROM darwin_v2_pipeline_audit
    WHERE inserted_at >= NOW() - INTERVAL '7 days'
    """

    cost_sql = """
    SELECT COALESCE(SUM(cost_usd), 0.0)::float AS weekly_cost
    FROM darwin_llm_cost_tracking
    WHERE timestamp >= NOW() - INTERVAL '7 days'
    """

    with {:ok, %{rows: [[applied, failed, avg]]}} <- TeamJay.Repo.query(sql, []),
         {:ok, %{rows: [[cost]]}} <- TeamJay.Repo.query(cost_sql, []) do
      {:ok, %{
        applied_7d:    applied || 0,
        failed_7d:     failed  || 0,
        avg_score_7d:  avg     || 0.0,
        llm_cost_7d:   cost    || 0.0
      }}
    else
      _ -> {:ok, %{applied_7d: 0, failed_7d: 0, avg_score_7d: 0.0, llm_cost_7d: 0.0}}
    end
  rescue
    _ -> {:ok, %{applied_7d: 0, failed_7d: 0, avg_score_7d: 0.0, llm_cost_7d: 0.0}}
  end

  defp collect_shadow_stats do
    shadow_enabled =
      System.get_env("DARWIN_SHADOW_ENABLED", "false") == "true" or
      Application.get_env(:darwin, :shadow_mode, false)

    if shadow_enabled do
      sql = """
      SELECT
        COUNT(*) FILTER (WHERE stage = 'shadow_match')::int AS matches,
        COUNT(*) FILTER (WHERE stage = 'shadow_mismatch')::int AS mismatches
      FROM darwin_v2_pipeline_audit
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
        AND stage LIKE 'shadow_%'
      """

      case TeamJay.Repo.query(sql, []) do
        {:ok, %{rows: [[matches, mismatches]]}} ->
          total = (matches || 0) + (mismatches || 0)
          rate  = if total > 0, do: Float.round((matches || 0) / total, 3), else: nil

          %{enabled: true, matches: matches || 0, mismatches: mismatches || 0, agreement_rate: rate}

        _ ->
          %{enabled: true, matches: 0, mismatches: 0, agreement_rate: nil}
      end
    else
      %{enabled: false}
    end
  rescue
    _ -> %{enabled: false}
  end

  # ──────────────────────────────────────────────
  # 내부 — LLM 분석
  # ──────────────────────────────────────────────

  defp generate_review_summary(sections) do
    prompt = build_review_prompt(sections)

    case Darwin.V2.LLM.Selector.complete("darwin.commander",
           [%{role: "user", content: prompt}],
           max_tokens: 1500,
           task_type: :structured_reasoning
         ) do
      {:ok, content} when is_binary(content) and content != "" ->
        {:ok, content}

      {:error, reason} ->
        Logger.warning("[다윈V2 메타리뷰] LLM 분석 실패: #{inspect(reason)} — 요약 생략")
        {:ok, build_fallback_summary(sections)}
    end
  end

  defp build_review_prompt(sections) do
    pipeline = sections.pipeline
    cost     = sections.llm_cost
    autonomy = sections.autonomy
    keywords = sections.keywords

    shadow_section =
      if sections.shadow[:enabled] do
        """
        ## 5. Shadow 모드
        - 일치율: #{sections.shadow[:agreement_rate] || "데이터 없음"}
        - 일치: #{sections.shadow[:matches]}건, 불일치: #{sections.shadow[:mismatches]}건
        """
      else
        "## 5. Shadow 모드: 비활성\n"
      end

    failures_text =
      pipeline.recent_failures
      |> Enum.map(fn f -> "  - [#{f[:stage]}] #{f[:reason]}: #{f[:paper_title]}" end)
      |> Enum.join("\n")

    """
    다윈 V2 연구 파이프라인 주간 리뷰를 작성하세요. 아래 데이터를 분석하여 한국어로 작성.

    ## 1. 파이프라인 메트릭 (7일)
    - 전체 처리: #{pipeline.total}건
    - 평가 완료: #{pipeline.evaluated}건
    - 구현 완료: #{pipeline.implemented}건
    - 검증 통과: #{pipeline.verified}건
    - 적용 완료: #{pipeline.applied}건
    - 파이프라인 헬스: #{pipeline.health}
    - 최근 실패:
    #{if failures_text == "", do: "  없음", else: failures_text}

    ## 2. LLM 비용
    - 일일 평균: $#{Float.round(cost.daily_usd, 3)}
    - 주간 합계: $#{Float.round(cost.weekly_usd, 3)}
    - 일일 예산: $#{cost.budget}

    ## 3. 키워드 효과성
    - 총 키워드: #{keywords.total}개
    - 상위 키워드: #{Enum.join(keywords.top, ", ")}

    ## 4. 자율 레벨
    - 현재 레벨: L#{autonomy.level}
    - 7일 적용: #{autonomy.papers_applied_7d}건
    - 7일 검증: #{autonomy.papers_verified_7d}건
    - 평균 점수: #{autonomy.avg_score_7d}

    #{shadow_section}

    ## 요청
    위 데이터를 바탕으로:
    1. 이번 주 연구 성과 요약 (2-3문장)
    2. 주요 문제점 분석
    3. 다음 주 구체적 개선 권고사항 3-5가지 (번호 목록 형식)
    4. 자율 레벨 조정 여부 권고

    형식: 각 섹션을 ## 헤더로 구분하여 작성하세요.
    """
  end

  defp build_fallback_summary(sections) do
    """
    ## 주간 성과 요약
    파이프라인: #{sections.pipeline.applied}건 적용 / #{sections.pipeline.evaluated}건 평가 완료.
    자율 레벨 L#{sections.autonomy.level} 운영 중.
    LLM 비용 주간 $#{Float.round(sections.llm_cost.weekly_usd, 3)}.

    ## 개선 권고사항
    1. 키워드 다양성 검토
    2. 검증 실패 패턴 분석
    3. LLM 비용 최적화 검토
    """
  end

  defp extract_recommendations(summary) when is_binary(summary) do
    # 번호 목록 형식의 권고사항 추출
    summary
    |> String.split("\n")
    |> Enum.filter(fn line ->
      Regex.match?(~r/^\d+\./, String.trim(line))
    end)
    |> Enum.map(&String.trim/1)
    |> Enum.take(10)
  end

  defp extract_recommendations(_), do: []

  # ──────────────────────────────────────────────
  # 내부 — 지속성 + 브로드캐스트
  # ──────────────────────────────────────────────

  defp store_in_memory(review) do
    content = """
    [다윈V2 주간 메타 리뷰 #{review.date}]
    #{review.summary}
    권고사항: #{Enum.join(review.recommendations, " | ")}
    """

    Darwin.V2.Memory.L2.store("darwin", content, :episodic,
      importance: 0.9,
      context: %{
        type:          "meta_review",
        date:          to_string(review.date),
        applied_count: get_in(review, [:sections, :pipeline, :applied]) || 0
      },
      tags: ["meta_review", "weekly", "darwin"]
    )
  rescue
    e -> Logger.warning("[다윈V2 메타리뷰] L2 저장 실패: #{Exception.message(e)}")
  end

  defp persist_review(review) do
    sql = """
    INSERT INTO darwin_v2_pipeline_audit
      (paper_url, paper_title, stage, score, metadata, inserted_at)
    VALUES (NULL, $1, 'meta_review', NULL, $2::jsonb, NOW())
    """

    meta = Jason.encode!(%{
      date:            to_string(review.date),
      summary:         String.slice(review.summary, 0, 2000),
      recommendations: review.recommendations
    })

    case TeamJay.Repo.query(sql, ["주간 메타 리뷰 #{review.date}", meta]) do
      {:ok, _} ->
        Logger.info("[다윈V2 메타리뷰] DB 저장 완료")

      {:error, reason} ->
        Logger.warning("[다윈V2 메타리뷰] DB 저장 실패: #{inspect(reason)}")
    end
  rescue
    e -> Logger.warning("[다윈V2 메타리뷰] persist_review 예외: #{Exception.message(e)}")
  end

  defp broadcast_review(review) do
    payload = %{
      type:            "meta_review",
      date:            review.date,
      summary:         String.slice(review.summary, 0, 500),
      recommendations: review.recommendations,
      health:          get_in(review, [:sections, :pipeline, :health])
    }

    Registry.dispatch(TeamJay.JayBus, "darwin.meta_review", fn entries ->
      for {pid, _} <- entries do
        send(pid, {:jay_event, "darwin.meta_review", payload})
      end
    end)

    # HubClient 알림 (권고사항 포함)
    recs_text =
      review.recommendations
      |> Enum.take(3)
      |> Enum.join("\n")

    HubClient.post_alarm(
      "다윈 V2 주간 메타 리뷰\n#{to_string(review.date)}\n\n권고사항:\n#{recs_text}",
      "darwin-meta-review", "darwin"
    )
  rescue
    e -> Logger.warning("[다윈V2 메타리뷰] 브로드캐스트 실패: #{Exception.message(e)}")
  end

  defp trigger_espl_evolution(sections) do
    Logger.info("[다윈V2 메타리뷰] ESPL 주간 진화 트리거...")

    # 파이프라인 성과가 낮으면 진화 강도 높임
    applied = get_in(sections, [:pipeline, :applied]) || 0

    if applied < 3 do
      Logger.info("[다윈V2 메타리뷰] 적용 건수 낮음(#{applied}) → ESPL 전체 진화")
      ESPL.run_weekly()
    else
      Logger.info("[다윈V2 메타리뷰] 성과 양호(#{applied}) → ESPL 평가자만 진화")
      ESPL.evolve("darwin.evaluator")
    end
  rescue
    e -> Logger.warning("[다윈V2 메타리뷰] ESPL 트리거 실패: #{Exception.message(e)}")
  end

  defp format_next_review do
    next_ms = @review_interval_ms
    next_dt = DateTime.add(DateTime.utc_now(), div(next_ms, 1000), :second)
    Calendar.strftime(next_dt, "%Y-%m-%d %H:%M UTC")
  end
end
