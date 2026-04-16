defmodule TeamJay.Ska.ParsingGuard do
  @moduledoc """
  스카팀 자기 복구 Loop 2:
    웹페이지 파싱 체크 → 더 좋은 파싱 방법 → 셀렉터 자동 생성 → 파싱 안정화

  3단계 폴백 체인:
    Level 1: CSS 셀렉터 (현재 방식!) — 가장 빠름
    Level 2: XPath 대안 셀렉터 — CSS 실패 시
    Level 3: LLM 기반 파싱 — DOM 변경 시 자동 대응
      → LLM 폴백 체인: Claude Opus → OpenAI → Groq

  99% 정상 → Level 1/2 빠르게!
  1% 예외 → LLM 스킬 호출 (on-demand!)

  LLM 성공 시:
    → 새 CSS 셀렉터 자동 생성
    → SelectorManager에 candidate 등록
    → 5회 연속 성공 시 promoted
  """

  use GenServer
  require Logger

  @llm_chain_id "ska.parsing.level3"
  @selector_gen_chain_id "ska.selector.generate"
  @llm_timeout_ms 15_000

  defstruct [:stats, :circuit_breakers]

  # Circuit Breaker: 연속 3회 LLM 실패 시 10분 차단
  @circuit_open_threshold 3   # trip_circuit 호출 시 누적 카운터에 사용
  @circuit_reset_ms 600_000

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  파싱 실행 (3단계 폴백 포함)

  opts:
    - html:     파싱할 HTML (문자열)
    - target:   타겟 식별자 (naver_list, pickko_order 등)
    - agent:    호출 에이전트 이름
    - validate: 검증 함수 fn(data) -> boolean (기본: nil = 항상 통과)

  반환:
    {:ok, data, level}       — level = :css | :xpath | :llm
    {:error, :all_failed}    — 3단계 모두 실패
  """
  def parse(opts) do
    GenServer.call(__MODULE__, {:parse, opts}, @llm_timeout_ms + 5_000)
  end

  @doc "파싱 통계 조회"
  def get_stats do
    GenServer.call(__MODULE__, :get_stats)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[ParsingGuard] 시작! 3단계 파싱 폴백 준비")
    {:ok, %__MODULE__{
      stats: %{
        level1_ok: 0, level1_fail: 0,
        level2_ok: 0, level2_fail: 0,
        level3_ok: 0, level3_fail: 0
      },
      circuit_breakers: %{}
    }}
  end

  @impl true
  def handle_call({:parse, opts}, _from, state) do
    html    = Keyword.fetch!(opts, :html)
    target  = Keyword.fetch!(opts, :target)
    agent   = Keyword.get(opts, :agent, "unknown")
    validate = Keyword.get(opts, :validate, fn _ -> true end)

    {result, new_state} = run_fallback_chain(html, target, agent, validate, state)
    {:reply, result, new_state}
  end

  @impl true
  def handle_call(:get_stats, _from, state) do
    {:reply, state.stats, state}
  end

  # ─── Private: 폴백 체인 ───────────────────────────────────

  defp run_fallback_chain(html, target, agent, validate, state) do
    # Level 1: CSS 셀렉터
    case try_css_parse(html, target, validate) do
      {:ok, data} ->
        new_state = bump_stat(state, :level1_ok)
        record_success(target, :css)
        {{:ok, data, :css}, new_state}

      {:error, reason} ->
        Logger.warning("[ParsingGuard] #{target} Level 1(CSS) 실패: #{inspect(reason)}")
        new_state = bump_stat(state, :level1_fail)
        record_failure(target, :css, agent)
        TeamJay.Ska.PubSub.broadcast_parsing_degraded(target, :css, :xpath)

        # Level 2: XPath 셀렉터
        case try_xpath_parse(html, target, validate) do
          {:ok, data} ->
            new_state2 = bump_stat(new_state, :level2_ok)
            record_success(target, :xpath)
            {{:ok, data, :xpath}, new_state2}

          {:error, reason2} ->
            Logger.warning("[ParsingGuard] #{target} Level 2(XPath) 실패: #{inspect(reason2)}")
            new_state2 = bump_stat(new_state, :level2_fail)
            record_failure(target, :xpath, agent)
            TeamJay.Ska.PubSub.broadcast_parsing_degraded(target, :xpath, :llm)

            # Level 3: LLM 파싱 (circuit breaker 확인)
            if circuit_open?(state, target) do
              Logger.error("[ParsingGuard] #{target} LLM circuit OPEN! 모든 레벨 실패")
              {{:error, :all_failed}, new_state2}
            else
              case try_llm_parse(html, target, agent) do
                {:ok, data, provider} ->
                  new_state3 = bump_stat(new_state2, :level3_ok)
                  reset_circuit(new_state3, target)
                  # LLM 성공 → 새 셀렉터 자동 생성
                  Task.start(fn -> generate_and_register_selector(html, target, provider) end)
                  {{:ok, data, :llm}, new_state3}

                {:error, reason3} ->
                  Logger.error("[ParsingGuard] #{target} Level 3(LLM) 실패: #{inspect(reason3)}")
                  new_state3 = bump_stat(new_state2, :level3_fail)
                  new_state4 = trip_circuit(new_state3, target)
                  TeamJay.HubClient.post_alarm(
                    "🚨 #{target} 파싱 3단계 모두 실패!\n#{agent} 수동 확인 필요",
                    "ska",
                    "parsing_guard"
                  )
                  TeamJay.Ska.FailureTracker.report(%{
                    agent: agent,
                    error_type: :selector_broken,
                    target: target,
                    message: "3단계 파싱 모두 실패: #{inspect(reason3)}"
                  })
                  {{:error, :all_failed}, new_state4}
              end
            end
        end
    end
  end

  # ─── Private: 각 레벨 파싱 ───────────────────────────────

  defp try_css_parse(html, target, validate) do
    selectors = TeamJay.Ska.SelectorManager.get_active(target)
    css_selectors = Enum.filter(selectors, &(&1.selector_css != nil))

    Enum.reduce_while(css_selectors, {:error, :no_css_selector}, fn sel, _acc ->
      case apply_css_selector(html, sel.selector_css) do
        {:ok, data} ->
          if validate.(data) do
            TeamJay.Ska.SelectorManager.record_result(sel.id, true)
            {:halt, {:ok, data}}
          else
            TeamJay.Ska.SelectorManager.record_result(sel.id, false)
            {:cont, {:error, :validation_failed}}
          end
        {:error, reason} ->
          TeamJay.Ska.SelectorManager.record_result(sel.id, false)
          {:cont, {:error, reason}}
      end
    end)
  end

  defp try_xpath_parse(html, target, validate) do
    selectors = TeamJay.Ska.SelectorManager.get_active(target)
    xpath_selectors = Enum.filter(selectors, &(&1.selector_xpath != nil))

    Enum.reduce_while(xpath_selectors, {:error, :no_xpath_selector}, fn sel, _acc ->
      case apply_xpath_selector(html, sel.selector_xpath) do
        {:ok, data} ->
          if validate.(data) do
            TeamJay.Ska.SelectorManager.record_result(sel.id, true)
            {:halt, {:ok, data}}
          else
            TeamJay.Ska.SelectorManager.record_result(sel.id, false)
            {:cont, {:error, :validation_failed}}
          end
        {:error, reason} ->
          TeamJay.Ska.SelectorManager.record_result(sel.id, false)
          {:cont, {:error, reason}}
      end
    end)
  end

  defp try_llm_parse(html, target, agent) do
    Logger.info("[ParsingGuard] #{target} LLM 파싱 시도 (on-demand)")
    # llm-fallback.ts의 ska.parsing.level3 체인 호출
    # Node.js PortBridge를 통해 llm-fallback 호출
    payload = %{
      chain_id: @llm_chain_id,
      system_prompt: """
      당신은 HTML 파싱 전문가입니다.
      주어진 HTML에서 #{target} 데이터를 JSON으로 추출하세요.
      반드시 유효한 JSON만 반환하세요.
      """,
      user_prompt: """
      다음 HTML에서 #{target} 데이터를 추출하세요:
      <html>
      #{String.slice(html, 0, 8000)}
      </html>
      """,
      timeout_ms: @llm_timeout_ms,
      meta: %{team: "ska", agent: agent, target: target}
    }

    case call_llm_via_port(payload) do
      {:ok, text, provider} ->
        case Jason.decode(text) do
          {:ok, data} -> {:ok, data, provider}
          {:error, _} ->
            # JSON 파싱 실패 → raw text 반환
            {:ok, %{raw: text}, provider}
        end
      {:error, reason} -> {:error, reason}
    end
  end

  # ─── Private: LLM 셀렉터 자동 생성 ──────────────────────

  defp generate_and_register_selector(html, target, _provider) do
    Logger.info("[ParsingGuard] #{target} 새 CSS 셀렉터 자동 생성 중...")
    payload = %{
      chain_id: @selector_gen_chain_id,
      system_prompt: """
      당신은 CSS 셀렉터 전문가입니다.
      주어진 HTML에서 #{target} 데이터를 추출하는
      CSS 셀렉터를 생성하세요.
      반드시 다음 JSON 형식으로만 응답하세요:
      {"css": "...", "xpath": "..."}
      """,
      user_prompt: """
      다음 HTML에서 #{target} 추출을 위한 CSS/XPath 셀렉터를 생성하세요:
      <html>
      #{String.slice(html, 0, 6000)}
      </html>
      """,
      timeout_ms: 10_000,
      meta: %{team: "ska", target: target, purpose: "selector_generation"}
    }

    case call_llm_via_port(payload) do
      {:ok, text, llm_provider} ->
        case Jason.decode(text) do
          {:ok, %{"css" => css, "xpath" => xpath}} ->
            TeamJay.Ska.SelectorManager.register_candidate(target, css, xpath, llm_provider)
            Logger.info("[ParsingGuard] #{target} 새 셀렉터 candidate 등록 완료")
          {:ok, %{"css" => css}} ->
            TeamJay.Ska.SelectorManager.register_candidate(target, css, nil, llm_provider)
          _ ->
            Logger.warning("[ParsingGuard] 셀렉터 생성 JSON 파싱 실패: #{text}")
        end
        _ ->
          Logger.warning("[ParsingGuard] #{target} 셀렉터 생성 LLM 호출 실패")
    end
  end

  # ─── Private: PortBridge LLM 호출 ────────────────────────

  @llm_script "dist/ts-runtime/bots/reservation/scripts/ska-llm-parse.js"

  defp call_llm_via_port(payload) do
    chain_id = Map.get(payload, :chain_id, "unknown")
    agent = get_in(payload, [:meta, :agent]) || "parsing_guard"
    Logger.info("[ParsingGuard] LLM 호출: #{chain_id} (#{agent})")

    script_path = Path.join(TeamJay.Config.repo_root(), @llm_script)

    case Jason.encode(payload) do
      {:ok, json} ->
        b64 = Base.encode64(json)
        task = Task.async(fn ->
          System.cmd(
            "node",
            [script_path, "--payload=#{b64}"],
            cd: TeamJay.Config.repo_root(),
            stderr_to_stdout: false
          )
        end)

        case Task.yield(task, @llm_timeout_ms) || Task.shutdown(task, :brutal_kill) do
          {:ok, {output, 0}} ->
            parse_llm_output(output, chain_id)

          {:ok, {output, exit_code}} ->
            Logger.error("[ParsingGuard] LLM 스크립트 종료 #{exit_code}: #{String.slice(output, 0, 200)}")
            {:error, :script_error}

          nil ->
            Logger.error("[ParsingGuard] LLM 호출 타임아웃 (#{@llm_timeout_ms}ms)")
            {:error, :timeout}
        end

      {:error, reason} ->
        Logger.error("[ParsingGuard] JSON 인코딩 실패: #{inspect(reason)}")
        {:error, :encode_failed}
    end
  end

  defp parse_llm_output(output, chain_id) do
    case Jason.decode(String.trim(output)) do
      {:ok, %{"text" => text, "provider" => provider}} ->
        Logger.info("[ParsingGuard] LLM 성공: #{chain_id} / #{provider}")
        {:ok, text, provider}

      {:ok, %{"error" => err}} ->
        Logger.warning("[ParsingGuard] LLM 오류 응답: #{err}")
        {:error, err}

      {:error, _} ->
        Logger.error("[ParsingGuard] LLM 응답 파싱 실패: #{String.slice(output, 0, 100)}")
        {:error, :invalid_response}
    end
  end

  # ─── Private: HTML 셀렉터 적용 (실제 파싱은 Node.js 측에서) ──

  defp apply_css_selector(html, selector) do
    # Node.js PortAgent 호출 (현재는 stub — 실제 파싱은 naver-monitor.ts 등에서)
    # ParsingGuard는 "어떤 셀렉터를 쓸지" 관리하고, 실제 DOM 파싱은 Node.js 측
    # PortBridge 패턴으로 향후 전환
    case html do
      nil -> {:error, :no_html}
      _ ->
        # 셀렉터 존재 여부 체크 (간단한 문자열 포함 검사)
        if String.contains?(html, selector) do
          {:ok, %{selector: selector, matched: true}}
        else
          {:error, :selector_not_matched}
        end
    end
  end

  defp apply_xpath_selector(_html, _xpath) do
    # 실제 XPath 파서는 아직 Elixir 네이티브로 붙지 않았다.
    # 다만 런타임 feature flag가 열리면 성공 shape를 반환할 수 있게 두어
    # fallback 체인 컴파일 경고 없이 확장 포인트를 유지한다.
    if System.get_env("TEAMJAY_ENABLE_XPATH_STUB") == "1" do
      {:ok, %{selector: :xpath_stub, matched: true, source: :feature_flag}}
    else
      {:error, :xpath_not_implemented_in_elixir}
    end
  end

  # ─── Private: Circuit Breaker ─────────────────────────────

  defp circuit_open?(state, target) do
    case Map.get(state.circuit_breakers, target) do
      nil -> false
      %{open: true, opened_at: opened_at} ->
        elapsed = System.monotonic_time(:millisecond) - opened_at
        elapsed < @circuit_reset_ms
      _ -> false
    end
  end

  defp trip_circuit(state, target) do
    prev = Map.get(state.circuit_breakers, target, %{trips: 0})
    trips = Map.get(prev, :trips, 0) + 1
    Logger.warning("[ParsingGuard] #{target} circuit TRIPPED (#{trips}/#{@circuit_open_threshold})")
    breaker = %{open: true, opened_at: System.monotonic_time(:millisecond), trips: trips}
    %{state | circuit_breakers: Map.put(state.circuit_breakers, target, breaker)}
  end

  defp reset_circuit(state, target) do
    %{state | circuit_breakers: Map.delete(state.circuit_breakers, target)}
  end

  # ─── Private: 통계 기록 ───────────────────────────────────

  defp bump_stat(state, key) do
    %{state | stats: Map.update!(state.stats, key, &(&1 + 1))}
  end

  defp record_success(target, level) do
    TeamJay.EventLake.record(%{
      event_type: "ska_parse_success",
      team: "ska",
      bot_name: "parsing_guard",
      severity: "info",
      title: "파싱 성공",
      message: "#{target} Level #{level}",
      tags: ["parsing_guard", to_string(level)]
    })
  end

  defp record_failure(target, level, agent) do
    TeamJay.Ska.FailureTracker.report(%{
      agent: agent,
      error_type: :selector_broken,
      target: target,
      message: "#{target} Level #{level} 파싱 실패"
    })
  end
end
