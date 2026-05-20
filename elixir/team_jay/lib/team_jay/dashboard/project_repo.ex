defmodule TeamJay.Dashboard.ProjectRepo do
  @moduledoc """
  Visibility v3.4 project persistence facade.

  `ProjectVisibility` remains the compatibility adapter used by the LiveView.
  This module gives Phase G/Cycle #52 a stable repo boundary for schema,
  ingest, task stage changes, and milestone reconciliation.
  """

  alias TeamJay.Dashboard.ProjectVisibility

  def ensure_schema!, do: ProjectVisibility.ensure_schema!()
  def schema_ready?, do: ProjectVisibility.schema_ready?()
  def snapshot(opts \\ []), do: ProjectVisibility.snapshot(opts)
  def update_task_stage(task_id, stage), do: ProjectVisibility.update_task_stage(task_id, stage)
  def ingest_event(event), do: ProjectVisibility.ingest_event(event)

  def ingest_recent_event_lake_tasks!(opts \\ []),
    do: ProjectVisibility.ingest_recent_event_lake_tasks!(opts)

  def ingest_task!(attrs), do: ProjectVisibility.ingest_task!(attrs)
  def reconcile_milestones!, do: ProjectVisibility.reconcile_milestone_statuses!()
end
