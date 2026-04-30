defmodule Jay.V2.CrossTeamRouter do
  @moduledoc """
  팀 간 데이터 파이프라인 실행기 (JayBus 구독자).
  Topics.broadcast → CrossTeamRouter가 수신 → 대상 팀에 Hub API로 지시.

  7개 파이프라인:
    ska → blog  : 스카 매출 하락 → 블로팀 프로모션 콘텐츠 요청
    luna → blog : 루나 시장 급변 → 블로팀 투자 콘텐츠 요청
    blog → ska  : 블로 고성과 키워드 → 스카 SEO 반영
    ska → luna  : 스카 캐시플로우 → 루나 투자 강도 조정
    claude → all: 시스템 위험 → 전체 워크로드 축소
    blog → luna : 트렌드 → 루나 종목 분석
    luna → ska  : 루나 수익 실현 → 스카 운영비 알림
  """

  use GenServer
  require Logger
  alias Jay.V2.{CommandEnvelope, CommandTracker, Topics}

  @system_risk_cooldown_seconds 900

  # ────────────────────────────────────────────────────────────────
  # GenServer 생명주기
  # ────────────────────────────────────────────────────────────────

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  @impl true
  def init(state) do
    # 7개 크로스 파이프라인 토픽 구독
    for topic <- Topics.cross_topics() do
      Topics.subscribe(topic)
    end
    Logger.info("[CrossTeamRouter] 시작! 팀 간 파이프라인 7개 구독 완료")
    {:ok, Map.put(state, :last_system_risk, nil)}
  end

  # ────────────────────────────────────────────────────────────────
  # JayBus 메시지 수신
  # ────────────────────────────────────────────────────────────────

  @impl true
  def handle_info({:jay_bus, topic, payload}, state) when topic in [:ska_to_blog, :luna_to_blog,
      :blog_to_ska, :ska_to_luna, :blog_to_luna, :luna_to_ska] do
    # 자율화 단계 gate — Phase 3에서 allow 결정은 발송 생략 (escalate/block은 항상 전달)
    if Jay.V2.AutonomyController.should_notify_pipeline?(:allow) do
      dispatch_pipeline(topic, payload)
    else
      phase = Jay.V2.AutonomyController.get_phase()
      Logger.debug("[CrossTeamRouter] #{topic}: Phase #{phase} 자율 — 생략")
    end
    {:noreply, state}
  end

  # claude_to_all은 phase 관계없이 항상 실행 (시스템 안전)
  @impl true
  def handle_info({:jay_bus, :claude_to_all, payload}, state) do
    {:noreply, handle_claude_to_all(payload, state)}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ────────────────────────────────────────────────────────────────
  # 디스패치 라우터
  # ────────────────────────────────────────────────────────────────

  defp dispatch_pipeline(:ska_to_blog, payload),  do: handle_ska_to_blog(payload)
  defp dispatch_pipeline(:luna_to_blog, payload), do: handle_luna_to_blog(payload)
  defp dispatch_pipeline(:blog_to_ska, payload),  do: handle_blog_to_ska(payload)
  defp dispatch_pipeline(:ska_to_luna, payload),  do: handle_ska_to_luna(payload)
  defp dispatch_pipeline(:blog_to_luna, payload), do: handle_blog_to_luna(payload)
  defp dispatch_pipeline(:luna_to_ska, payload),  do: handle_luna_to_ska(payload)
  defp dispatch_pipeline(topic, _payload), do: Logger.warning("[CrossTeamRouter] 미등록 파이프라인: #{topic}")

  # ────────────────────────────────────────────────────────────────
  # 파이프라인 1: 스카 → 블로 (매출 하락 → 프로모션)
  # ────────────────────────────────────────────────────────────────

  defp handle_ska_to_blog(%{drop_pct: drop_pct, details: details}) do
    revenue = details[:revenue_7d] || 0
    envelope =
      CommandEnvelope.build(
        :create_promotion_content,
        :ska,
        :blog,
        %{
          drop_pct: drop_pct,
          revenue_7d: revenue,
          keyword_hints: ["분당서현 스터디카페", "커피랑도서관 할인"]
        }
      )

    message = """
    📢 [제이→블로] 스카팀 매출 하락 감지!
    📉 하락률: #{drop_pct}%
    💰 7일 매출: #{format_krw(revenue)}
    🎯 요청: 스카 스터디카페 프로모션 블로그 포스트 1건 긴급 발행
    키워드 힌트: 분당서현 스터디카페, 커피랑도서관 할인
    """
    dispatch_team_command(:ska_to_blog, "blog", message, envelope)
    record_pipeline_event(:ska_to_blog, :executed, %{drop_pct: drop_pct, revenue: revenue, command: envelope})
    Logger.info("[CrossTeamRouter] ska→blog 실행: 하락 #{drop_pct}%, #{format_krw(revenue)}")
  end

  defp handle_ska_to_blog(_), do: :ok

  # ────────────────────────────────────────────────────────────────
  # 파이프라인 2: 루나 → 블로 (시장 급변 → 투자 콘텐츠)
  # ────────────────────────────────────────────────────────────────

  defp handle_luna_to_blog(%{regime: regime, details: details}) do
    {mood, keyword_hint, angle_hint, urgency} = regime_to_blog_params(regime)

    content_request_id = record_content_request(%{
      source_team: "luna",
      source_event: "market_shock",
      regime: regime,
      mood: mood,
      angle_hint: angle_hint,
      keyword_hints: String.split(keyword_hint, ", "),
      urgency: urgency,
      metadata: %{regime: regime, mood: mood, details: details}
    })

    envelope =
      CommandEnvelope.build(
        :create_investment_content,
        :luna,
        :blog,
        %{regime: regime, mood: mood, keyword_hint: keyword_hint, content_request_id: content_request_id}
      )

    message = """
    📢 [제이→블로] 루나팀 시장 급변 감지!
    📊 현재 체제: #{regime} (#{mood})
    🎯 요청 ID: #{content_request_id || "N/A"} (blog.content_requests)
    🔑 앵글: #{angle_hint}
    키워드 힌트: #{keyword_hint}
    """
    dispatch_team_command(:luna_to_blog, "blog", message, envelope)
    record_pipeline_event(:luna_to_blog, :executed, %{regime: regime, content_request_id: content_request_id, command: envelope})
    Logger.info("[CrossTeamRouter] luna→blog 실행: 체제=#{regime}, 요청 ID=#{content_request_id}")
  end

  defp handle_luna_to_blog(_), do: :ok

  defp regime_to_blog_params(regime) do
    case regime do
      "bull"     -> {"상승장",     "코인 상승 지금 사야 할까, 비트코인 전망",   "상승장 판단",   "normal"}
      "bear"     -> {"하락장",     "코인 하락 대응 전략, 하락장 투자 방법",     "하락장 대응",   "urgent"}
      "volatile" -> {"변동성 확대", "코인 변동성 대응, 리스크 관리",             "변동성 관리",   "urgent"}
      "crisis"   -> {"위기 국면",   "시장 위기 대응, 포지션 방어",               "위기 대응",     "urgent"}
      _          -> {"시장 변화",   "가상화폐 시장 분석",                         "시장 점검",     "low"}
    end
  end

  defp record_content_request(%{source_team: source_team, source_event: source_event,
                                regime: regime, mood: mood,
                                angle_hint: angle, keyword_hints: keywords,
                                urgency: urgency, metadata: metadata}) do
    sql = """
    INSERT INTO blog.content_requests
      (source_team, source_event, regime, mood, angle_hint, keyword_hints, urgency, metadata, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW() + INTERVAL '24 hours')
    RETURNING id
    """

    case Jay.Core.Repo.query(sql, [
      source_team, source_event, regime, mood,
      angle, keywords, urgency, Jason.encode!(metadata)
    ]) do
      {:ok, %{rows: [[id]]}} ->
        id
      {:error, reason} ->
        Logger.error("[CrossTeamRouter] content_requests INSERT 실패: #{inspect(reason)}")
        nil
    end
  rescue
    e ->
      Logger.error("[CrossTeamRouter] content_requests INSERT 예외: #{inspect(e)}")
      nil
  end

  # ────────────────────────────────────────────────────────────────
  # 파이프라인 3: 블로 → 스카 (키워드 → SEO)
  # ────────────────────────────────────────────────────────────────

  defp handle_blog_to_ska(%{keywords: keywords, details: _details}) do
    kw_list = Enum.join(keywords, ", ")
    envelope =
      CommandEnvelope.build(
        :apply_seo,
        :blog,
        :ska,
        %{keywords: keywords, keyword_count: length(keywords)}
      )

    message = """
    📢 [제이→스카] 블로팀 고성과 키워드 발견!
    🔑 키워드: #{kw_list}
    🎯 요청: 네이버 예약 상품명/설명에 키워드 반영 검토
    """
    dispatch_team_command(:blog_to_ska, "ska", message, envelope)
    record_pipeline_event(:blog_to_ska, :executed, %{keyword_count: length(keywords), command: envelope})
    Logger.info("[CrossTeamRouter] blog→ska 실행: 키워드 #{length(keywords)}개")
  end

  defp handle_blog_to_ska(_), do: :ok

  # ────────────────────────────────────────────────────────────────
  # 파이프라인 4: 스카 → 루나 (캐시플로우 → 투자 강도)
  # ────────────────────────────────────────────────────────────────

  defp handle_ska_to_luna(%{revenue_7d: revenue}) do
    intensity = cond do
      revenue >= 1_000_000 -> "공격적"
      revenue >= 500_000   -> "보통"
      true                 -> "보수적"
    end

    envelope =
      CommandEnvelope.build(
        :adjust_investment_intensity,
        :ska,
        :luna,
        %{revenue_7d: revenue, recommended_intensity: intensity}
      )

    message = """
    📢 [제이→루나] 스카팀 캐시플로우 업데이트!
    💰 7일 매출: #{format_krw(revenue)}
    📊 권장 투자 강도: #{intensity}
    """
    dispatch_team_command(:ska_to_luna, "luna", message, envelope)
    record_pipeline_event(:ska_to_luna, :executed, %{revenue: revenue, intensity: intensity, command: envelope})
    Logger.info("[CrossTeamRouter] ska→luna 실행: #{format_krw(revenue)} → #{intensity}")
  end

  defp handle_ska_to_luna(_), do: :ok

  # ────────────────────────────────────────────────────────────────
  # 파이프라인 5: 클로드 → 전체 (시스템 위험 → 워크로드 축소)
  # ────────────────────────────────────────────────────────────────

  defp handle_claude_to_all(%{risk_level: level, affected_services: services}, state) do
    normalized_services = normalize_affected_services(services)
    signature = system_risk_signature(level, normalized_services)

    cond do
      stale_core_system_risk?(signature) ->
        Logger.info("[CrossTeamRouter] claude→all stale core 위험 억제: 레벨=#{level}, 서비스=#{inspect(signature.services)}")
        record_pipeline_event(:claude_to_all, :suppressed, %{
          risk_level: level,
          affected_services: normalized_services,
          reason: "core_health_ok"
        })
        Map.put(state, :last_system_risk, signature)

      suppress_duplicate_system_risk?(state[:last_system_risk], signature) or
          persisted_duplicate_system_risk?(signature) ->
        Logger.info("[CrossTeamRouter] claude→all 중복 억제: 레벨=#{level}, 서비스=#{inspect(signature.services)}")
        record_pipeline_event(:claude_to_all, :suppressed, %{
          risk_level: level,
          affected_services: normalized_services,
          reason: "cooldown"
        })
        Map.put(state, :last_system_risk, signature)

      true ->
        teams = ["blog", "luna", "ska", "claude"]
        service_list = Enum.join(normalized_services, ", ")

        message = """
        🚨 [제이→전체] 시스템 위험 감지!
        ⚠️ 위험 레벨: #{level}/10
        🔧 비정상 서비스: #{service_list}
        🎯 요청: 비필수 작업 일시 중단, 필수 작업만 유지
        """

        Enum.each(teams, fn team ->
          envelope =
            CommandEnvelope.build(
              :reduce_workload,
              :claude,
              team,
              %{risk_level: level, affected_services: normalized_services}
            )

          dispatch_team_command(:claude_to_all, team, message, envelope)
        end)

        record_pipeline_event(:claude_to_all, :executed, %{
          risk_level: level,
          affected_services: normalized_services,
          teams_notified: teams
        })

        Logger.info("[CrossTeamRouter] claude→all 실행: 레벨=#{level}, #{length(teams)}팀 알림")
        Map.put(state, :last_system_risk, signature)
    end
  end

  defp handle_claude_to_all(_, state), do: state

  defp system_risk_signature(level, services) do
    %{
      risk_level: level,
      services: services |> List.wrap() |> Enum.map(&to_string/1) |> Enum.sort(),
      observed_at: DateTime.utc_now()
    }
  end

  defp suppress_duplicate_system_risk?(nil, _signature), do: false

  defp suppress_duplicate_system_risk?(
         %{risk_level: level, services: services, observed_at: observed_at},
         %{risk_level: level, services: services, observed_at: now}
       ) do
    DateTime.diff(now, observed_at, :second) < @system_risk_cooldown_seconds
  end

  defp suppress_duplicate_system_risk?(_, _), do: false

  defp normalize_affected_services(services) do
    services
    |> List.wrap()
    |> Enum.map(&(&1 |> to_string() |> String.trim() |> String.downcase()))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp stale_core_system_risk?(%{services: services}) do
    core_aliases =
      MapSet.new([
        "api",
        "db",
        "database",
        "postgres",
        "postgresql",
        "pg_pool",
        "hub",
        "dashboard",
        "health-dashboard"
      ])

    service_set = MapSet.new(services)

    MapSet.size(service_set) > 0 and
      MapSet.subset?(service_set, core_aliases) and
      current_core_health_ok?()
  end

  defp persisted_duplicate_system_risk?(signature) do
    case recent_system_risk_rows() do
      {:ok, %{"rows" => rows}} ->
        Enum.any?(rows, fn row ->
          payload = get_in(row, ["metadata", "command", "payload"]) || %{}
          risk_level = get_in(payload, ["risk_level"])
          services = normalize_affected_services(get_in(payload, ["affected_services"]) || [])
          risk_level == signature.risk_level and services == signature.services
        end)

      _ ->
        false
    end
  end

  defp recent_system_risk_rows do
    Jay.Core.HubClient.pg_query(
      """
      SELECT metadata
      FROM agent.event_lake
      WHERE created_at >= NOW() - interval '15 minutes'
        AND event_type IN ('cross_pipeline.command.issued', 'cross_pipeline.command_issued')
        AND metadata->>'pipeline' = 'claude_to_all'
      ORDER BY created_at DESC
      LIMIT 100
      """,
      "agent"
    )
  end

  defp current_core_health_ok? do
    case Jay.Core.HubClient.health() do
      {:ok, %{"resources" => resources}} when is_map(resources) ->
        resource_ok?(resources, "core_services") and
          resource_ok?(resources, "postgresql") and
          resource_ok?(resources, "pg_pool")

      _ ->
        false
    end
  end

  defp resource_ok?(resources, key) when is_map(resources) do
    case Map.get(resources, key) do
      %{"status" => "ok"} -> true
      _ -> false
    end
  end

  # ────────────────────────────────────────────────────────────────
  # 파이프라인 6: 블로 → 루나 (트렌드 → 종목 분석)
  # ────────────────────────────────────────────────────────────────

  defp handle_blog_to_luna(%{keywords: keywords}) do
    kw_list = Enum.join(keywords, ", ")
    envelope =
      CommandEnvelope.build(
        :analyze_trend_candidates,
        :blog,
        :luna,
        %{keywords: keywords, keyword_count: length(keywords)}
      )

    message = """
    📢 [제이→루나] 블로팀 트렌드 키워드 공유!
    🔑 트렌드: #{kw_list}
    🎯 요청: 관련 종목/코인 분석 검토
    """
    dispatch_team_command(:blog_to_luna, "luna", message, envelope)
    record_pipeline_event(:blog_to_luna, :executed, %{keyword_count: length(keywords), command: envelope})
    Logger.info("[CrossTeamRouter] blog→luna 실행")
  end

  defp handle_blog_to_luna(_), do: :ok

  # ────────────────────────────────────────────────────────────────
  # 파이프라인 7: 루나 → 스카 (수익 실현 → 운영비)
  # ────────────────────────────────────────────────────────────────

  defp handle_luna_to_ska(%{realized_pnl: pnl}) when is_number(pnl) and pnl > 0 do
    envelope =
      CommandEnvelope.build(
        :notify_budget_surplus,
        :luna,
        :ska,
        %{realized_pnl: pnl}
      )

    message = """
    📢 [제이→스카] 루나팀 수익 실현!
    💰 실현 수익: +$#{Float.round(pnl * 1.0, 2)}
    🎯 참고: 운영비 예산 여유 발생
    """
    dispatch_team_command(:luna_to_ska, "ska", message, envelope)
    record_pipeline_event(:luna_to_ska, :executed, %{realized_pnl: pnl, command: envelope})
    Logger.info("[CrossTeamRouter] luna→ska 실행: +$#{pnl}")
  end

  defp handle_luna_to_ska(_), do: :ok

  # ────────────────────────────────────────────────────────────────
  # EventLake 기록
  # ────────────────────────────────────────────────────────────────

  defp record_pipeline_event(pipeline, status, details) do
    Jay.Core.EventLake.record(%{
      source: "jay.cross_team_router",
      event_type: "cross_pipeline.#{pipeline}.#{status}",
      severity: "info",
      payload: details
    })
  rescue
    _ -> :ok
  end

  defp dispatch_team_command(pipeline, target_team, message, envelope) do
    CommandTracker.issued(pipeline, target_team, envelope, message: message)

    case Jay.Core.HubClient.post_alarm(message, target_team, "jay.cross_team_router") do
      {:ok, _response} ->
        CommandTracker.acknowledged(pipeline, target_team, envelope, message: message)
        :ok

      {:error, error} ->
        CommandTracker.failed(
          pipeline,
          target_team,
          envelope,
          message: message,
          detail: inspect(error),
          severity: "warn"
        )

        :ok

      other ->
        CommandTracker.acknowledged(
          pipeline,
          target_team,
          envelope,
          message: message,
          detail: inspect(other)
        )

        :ok
    end
  rescue
    _ -> :ok
  end

  # ────────────────────────────────────────────────────────────────
  # 유틸
  # ────────────────────────────────────────────────────────────────

  defp format_krw(n) when is_integer(n), do: "#{n}원"
  defp format_krw(n) when is_number(n), do: "#{trunc(n)}원"
  defp format_krw(_), do: "N/A"
end
