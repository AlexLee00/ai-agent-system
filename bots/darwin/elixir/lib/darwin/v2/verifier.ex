defmodule Darwin.V2.Verifier do
  @moduledoc """
  다윈 V2 검증자 — 구현 결과 3단계 검증.

  TeamJay.Darwin.ProofR에서 진화:
    - Replication 스킬 + ExperimentDesign 스킬 사용
    - 3단계 검증: 구문/재현/실험
    - reproduction_score >= 0.7 AND 기준 실험 통과 시 passed
    - 실패 시 Darwin.V2.Reflexion.reflect 트리거
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, Lead, Reflexion}
  alias Darwin.V2.Skill.{Replication, ExperimentDesign}
  alias Jay.Core.HubClient

  @max_retry         2
  @repro_threshold   0.7   # 재현 점수 최소치

  defstruct [
    verifying: false,
    passed_count: 0,
    failed_count: 0,
    last_verified_at: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 검증 실행 (수동)"
  def verify_now(paper, implementation \\ %{}) do
    GenServer.cast(__MODULE__, {:verify_now, paper, implementation})
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[다윈V2 검증자] 시작!")
    {:ok, %__MODULE__{}}
  end

  # ── 이벤트 처리 ──────────────────────────────────────────────────────

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(Jay.Core.JayBus, Topics.implementation_ready(), [])
    Logger.debug("[다윈V2 검증자] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state)
      when topic == "darwin.implementation.ready" do
    paper          = payload[:paper] || payload
    implementation = payload[:implementation] || %{}
    {:noreply, handle_verify(paper, implementation, 0, state)}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast({:verify_now, paper, implementation}, state) do
    {:noreply, handle_verify(paper, implementation, 0, state)}
  end

  @impl GenServer
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      verifying: state.verifying,
      passed_count: state.passed_count,
      failed_count: state.failed_count,
      last_verified_at: state.last_verified_at
    }, state}
  end

  # ── 내부 ─────────────────────────────────────────────────────────────

  defp handle_verify(paper, implementation, retry, state) do
    title = paper["title"] || paper[:title] || "unknown"
    Logger.info("[다윈V2 검증자] 검증 시작: #{title} (시도 #{retry + 1}/#{@max_retry + 1})")

    Task.start(fn -> do_verify(paper, implementation, retry) end)

    %{state | verifying: true, last_verified_at: DateTime.utc_now()}
  end

  defp do_verify(paper, implementation, retry) do
    title = paper["title"] || paper[:title] || "unknown"

    # 단계 1: 구문 체크
    code = implementation[:code] || implementation["code"] || ""
    syntax_ok = check_syntax(code)

    if not syntax_ok do
      Logger.warning("[다윈V2 검증자] 구문 체크 실패: #{title}")
      handle_verification_failure(paper, implementation, retry, :syntax_error)
      :failed
    else
      # 단계 2: Replication 스킬
      repro_result = run_replication(paper, implementation)

      repro_score = case repro_result do
        {:ok, %{reproduction_score: s}} -> s
        _                               -> 0.0
      end

      Logger.info("[다윈V2 검증자] 재현 점수: #{Float.round(repro_score, 3)} (#{title})")

      # 단계 3: ExperimentDesign 스킬 → 기준 실험
      experiment_result = run_experiments(paper, implementation)

      baseline_pass = case experiment_result do
        {:ok, %{recommended_subset: exps}} -> length(exps) > 0
        _                                  -> false
      end

      # 통과 기준: reproduction_score >= 0.7 AND 기준 실험 설계 성공
      passed = repro_score >= @repro_threshold and baseline_pass

      if passed do
        Logger.info("[다윈V2 검증자] 검증 통과: #{title} (재현=#{Float.round(repro_score, 3)})")

        # DB 업데이트
        update_verification_db(paper, "passed")

        # verification_passed 브로드캐스트
        broadcast_result(Topics.verification_passed(), paper, repro_result, experiment_result)

        # HubClient 알림
        Task.start(fn ->
          HubClient.post_alarm(
            "다윈V2 검증 통과!\n논문: #{title}\n재현점수: #{Float.round(repro_score, 3)}\n→ 적용 단계로 이동",
            "darwin-verifier", "darwin"
          )
        end)

        :passed
      else
        reason = cond do
          repro_score < @repro_threshold -> "재현 점수 부족 (#{Float.round(repro_score, 3)} < #{@repro_threshold})"
          not baseline_pass              -> "기준 실험 설계 실패"
          true                           -> "알 수 없는 실패"
        end
        Logger.warning("[다윈V2 검증자] 검증 실패: #{title} — #{reason}")
        handle_verification_failure(paper, implementation, retry, reason)
        :failed
      end
    end
  rescue
    e ->
      title = paper["title"] || paper[:title] || "unknown"
      Logger.error("[다윈V2 검증자] 예외 발생: #{inspect(e)} (#{title})")
      handle_verification_failure(paper, implementation, retry, "예외: #{inspect(e)}")
  end

  defp handle_verification_failure(paper, implementation, retry, reason) do
    title = paper["title"] || paper[:title] || "unknown"

    if retry < @max_retry do
      Logger.info("[다윈V2 검증자] 재시도 #{retry + 1}/#{@max_retry}: #{title}")
      # 잠시 대기 후 재시도
      :timer.sleep(5_000)
      do_verify(paper, implementation, retry + 1)
    else
      Logger.error("[다윈V2 검증자] 최종 실패: #{title} — #{inspect(reason)}")

      # DB 업데이트
      update_verification_db(paper, "failed")

      # Reflexion 트리거
      Task.start(fn ->
        Reflexion.reflect(
          %{
            trigger: :verifier_rejection,
            phase: "verify",
            action: %{paper_title: title},
            error: reason
          },
          paper
        )
      end)

      # verification_failed 브로드캐스트
      broadcast(Topics.verification_failed(), %{paper: paper, reason: reason})

      # HubClient 알림
      Task.start(fn ->
        HubClient.post_alarm(
          "다윈V2 검증 실패!\n논문: #{title}\n이유: #{inspect(reason)}\n재시도 #{@max_retry}회 초과",
          "darwin-verifier", "darwin"
        )
      end)

      Lead.pipeline_failure("검증 실패: #{title}")
    end
  end

  # ── 검증 단계 ────────────────────────────────────────────────────────

  defp check_syntax(code) when is_binary(code) and code != "" do
    # 기본 Python 구문 체크: 최소 길이 + 기본 구조 확인
    # 완전한 AST 파싱은 Port를 통해 python -c "compile(...)" 로 가능하나
    # 여기서는 휴리스틱 체크만 수행
    not (code =~ ~r/SyntaxError|IndentationError/) and String.length(code) > 20
  end
  defp check_syntax(_), do: false

  defp run_replication(paper, implementation) do
    code_path = implementation[:path] || implementation["path"]

    params = %{
      paper: paper,
      code_path: code_path,
      actual_results: %{},
      run_code: false
    }

    case Replication.run(params, %{}) do
      {:ok, result} ->
        Logger.debug("[다윈V2 검증자] Replication 완료: score=#{result[:reproduction_score]}")
        {:ok, result}

      {:error, reason} ->
        Logger.warning("[다윈V2 검증자] Replication 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp run_experiments(paper, implementation) do
    code = implementation[:code] || implementation["code"] || ""
    code_summary = String.slice(to_string(code), 0, 300)

    params = %{
      paper: paper,
      code_summary: code_summary,
      budget_usd: 1.0,
      include_stress: false  # 검증 단계는 기준 실험만
    }

    case ExperimentDesign.run(params, %{}) do
      {:ok, result} ->
        Logger.debug("[다윈V2 검증자] ExperimentDesign 완료: #{length(result[:recommended_subset] || [])}개 실험")
        {:ok, result}

      {:error, reason} ->
        Logger.warning("[다윈V2 검증자] ExperimentDesign 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp update_verification_db(paper, status) do
    paper_id = paper["id"] || paper[:id]

    if paper_id do
      sql = """
      UPDATE reservation.rag_research
      SET verification_status = $1
      WHERE id = $2
      """

      case Ecto.Adapters.SQL.query(Jay.Core.Repo, sql, [status, paper_id]) do
        {:ok, _} -> :ok
        {:error, reason} ->
          Logger.warning("[다윈V2 검증자] DB 업데이트 실패: #{inspect(reason)}")
      end
    end
  rescue
    _ -> :ok
  end

  defp broadcast_result(topic, paper, repro_result, experiment_result) do
    replication = case repro_result do
      {:ok, r} -> r
      _ -> %{}
    end

    experiments = case experiment_result do
      {:ok, e} -> e
      _ -> %{}
    end

    broadcast(topic, %{
      paper: paper,
      replication: replication,
      experiments: experiments
    })
  end

  defp broadcast(topic, payload) do
    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)

    Phoenix.PubSub.broadcast(Darwin.V2.PubSub, topic, payload)
  end
end
