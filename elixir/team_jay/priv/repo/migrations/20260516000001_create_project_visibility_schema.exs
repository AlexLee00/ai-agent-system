defmodule TeamJay.Repo.Migrations.CreateProjectVisibilitySchema do
  use Ecto.Migration

  def up do
    execute("CREATE SCHEMA IF NOT EXISTS project")

    execute("""
    CREATE TABLE IF NOT EXISTS project.projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      github TEXT,
      phase TEXT NOT NULL,
      progress NUMERIC(4,3) NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT 'gray',
      status TEXT NOT NULL DEFAULT 'active',
      owner TEXT[] NOT NULL DEFAULT '{}',
      last_activity TIMESTAMPTZ DEFAULT NOW()
    )
    """)

    execute("""
    CREATE TABLE IF NOT EXISTS project.tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES project.projects(id),
      stage TEXT NOT NULL DEFAULT 'spec',
      assignee TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      elapsed_seconds INT,
      source_doc TEXT,
      active_session_id TEXT,
      verify JSONB,
      observe JSONB
    )
    """)

    execute("""
    CREATE TABLE IF NOT EXISTS project.milestones (
      id TEXT PRIMARY KEY,
      date DATE NOT NULL,
      title TEXT NOT NULL,
      owner TEXT NOT NULL,
      task_ids TEXT[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'upcoming',
      project_id TEXT REFERENCES project.projects(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
    """)

    execute("""
    CREATE TABLE IF NOT EXISTS project.sessions (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      task_ids TEXT[] NOT NULL DEFAULT '{}',
      files_touched TEXT[] NOT NULL DEFAULT '{}',
      handover_doc TEXT,
      summary TEXT
    )
    """)

    execute("""
    CREATE TABLE IF NOT EXISTS project.metrics (
      id BIGSERIAL PRIMARY KEY,
      metric_date DATE NOT NULL DEFAULT CURRENT_DATE,
      active_projects INT NOT NULL DEFAULT 0,
      active_sessions INT NOT NULL DEFAULT 0,
      by_stage JSONB NOT NULL DEFAULT '{}'::jsonb,
      observe_warnings INT NOT NULL DEFAULT 0,
      conflicts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    execute(
      "CREATE INDEX IF NOT EXISTS idx_project_tasks_project_stage ON project.tasks(project_id, stage)"
    )

    execute("CREATE INDEX IF NOT EXISTS idx_project_milestones_date ON project.milestones(date)")

    execute(
      "CREATE INDEX IF NOT EXISTS idx_project_milestones_status ON project.milestones(status)"
    )

    execute(
      "CREATE INDEX IF NOT EXISTS idx_project_sessions_active ON project.sessions(ended_at) WHERE ended_at IS NULL"
    )

    execute(
      "CREATE INDEX IF NOT EXISTS idx_project_metrics_date ON project.metrics(metric_date, created_at DESC)"
    )
  end

  def down do
    execute("DROP INDEX IF EXISTS project.idx_project_metrics_date")
    execute("DROP INDEX IF EXISTS project.idx_project_sessions_active")
    execute("DROP INDEX IF EXISTS project.idx_project_milestones_status")
    execute("DROP INDEX IF EXISTS project.idx_project_milestones_date")
    execute("DROP INDEX IF EXISTS project.idx_project_tasks_project_stage")
    execute("DROP TABLE IF EXISTS project.metrics")
    execute("DROP TABLE IF EXISTS project.sessions")
    execute("DROP TABLE IF EXISTS project.milestones")
    execute("DROP TABLE IF EXISTS project.tasks")
    execute("DROP TABLE IF EXISTS project.projects")
  end
end
