defmodule Sigma.Directive do
  @moduledoc """
  시그마팀 Directive — 피드백 실행 타입드 효과.
  Jido Directive 확장으로 tier 0~3 분기 처리.
  참조: bots/sigma/docs/PLAN.md §6 Phase 2
  """

  defprotocol Executor do
    @spec execute(dir :: struct(), context :: map()) :: {:ok, map()} | {:error, term()}
    def execute(directive, context)
  end

  defmodule ApplyFeedback do
    @moduledoc "Tier 0~3 피드백 적용 Directive 구조체."
    @enforce_keys [:team, :tier, :action, :rollback_spec]
    defstruct [:team, :tier, :action, :rollback_spec, :analyst, :metadata, :timeout]
  end
end

defimpl Sigma.Directive.Executor, for: Sigma.Directive.ApplyFeedback do
  @moduledoc false

  def execute(%{tier: 0} = dir, _ctx) do
    Sigma.V2.Archivist.log_observation(dir)
    {:ok, %{tier: 0, outcome: :observed}}
  end

  def execute(%{tier: 1} = dir, _ctx) do
    case Sigma.V2.Signal.emit(%{
           type: "sigma.advisory.#{dir.team}",
           source: "sigma-v2",
           specversion: "1.0",
           data: dir.action,
           metadata: dir.metadata
         }) do
      {:ok, signal_id} ->
        Sigma.V2.Archivist.log_signal_sent(dir, signal_id)
        {:ok, %{tier: 1, outcome: :signal_emitted, signal_id: signal_id}}

      {:error, reason} ->
        Sigma.V2.Archivist.log_failure(dir, reason)
        {:error, reason}
    end
  end

  def execute(%{tier: 2} = dir, _ctx) do
    # Kill switch 확인
    if System.get_env("SIGMA_TIER2_AUTO_APPLY") != "true" do
      {:error, :tier2_disabled}
    else
      case Sigma.V2.Config.apply_patch(dir.team, dir.action[:patch] || dir.action) do
        {:ok, %{snapshot_id: snapshot_id}} ->
          before_metric = %{avg_score: 5.0}

          Sigma.V2.RollbackScheduler.schedule(
            directive_id: Ecto.UUID.generate(),
            snapshot_id: snapshot_id,
            before_metric: before_metric,
            team: dir.team,
            measure_at_ms: :timer.hours(24)
          )

          Sigma.V2.Archivist.log_tier2_applied(dir, snapshot_id)
          {:ok, %{tier: 2, outcome: :applied, snapshot_id: snapshot_id}}

        {:error, reason} ->
          Sigma.V2.Archivist.log_failure(dir, reason)
          {:error, reason}
      end
    end
  end

  def execute(%{tier: 3} = dir, _ctx) do
    case Sigma.V2.Mailbox.enqueue(dir) do
      {:ok, directive_id} ->
        Sigma.V2.TelegramBridge.notify_pending(dir, directive_id)
        {:ok, %{tier: 3, outcome: :queued, directive_id: directive_id}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def execute(%{tier: _t} = _dir, _ctx) do
    {:error, :unknown_tier}
  end
end
