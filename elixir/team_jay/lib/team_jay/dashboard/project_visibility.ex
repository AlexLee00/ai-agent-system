defmodule TeamJay.Dashboard.ProjectVisibility do
  @moduledoc """
  Visibility v3.3 project/milestone/timeline data adapter.

  The dashboard can render from PostgreSQL when the `project` schema exists,
  and falls back to deterministic marker data so area 10/11 remain visible
  before production seed data is applied.
  """

  require Logger

  alias Jay.Core.Repo

  @stage_keys ~w(spec building verify observing done)
  @kanban_stages [
    %{stage: "spec", label: "Spec", icon: "📋", class: "bg-gray-900/40"},
    %{stage: "building", label: "Building", icon: "🔨", class: "bg-blue-900/30"},
    %{stage: "verify", label: "Verify", icon: "✓", class: "bg-amber-900/30"},
    %{stage: "observing", label: "Observing", icon: "👁", class: "bg-purple-900/30"},
    %{stage: "done", label: "Done", icon: "✅", class: "bg-green-900/30"}
  ]

  @schema_objects ~w(
    project.projects
    project.tasks
    project.milestones
    project.sessions
    project.metrics
  )

  @default_projects [
    %{
      id: "ai-agent-system",
      name: "팀 제이 (ai-agent-system)",
      path: "/Users/alexlee/projects/ai-agent-system",
      phase: "Phase G",
      progress: 0.82,
      color: "green",
      owner: ["master", "metty", "codex"]
    },
    %{
      id: "blog-automation",
      name: "블로그 자동화",
      path: "/Users/alexlee/projects/ai-agent-system/bots/blog",
      phase: "V3 Shadow",
      progress: 0.68,
      color: "amber",
      owner: ["blog", "codex"]
    },
    %{
      id: "luna-autonomy",
      name: "루나 자율매매",
      path: "/Users/alexlee/projects/ai-agent-system/bots/investment",
      phase: "Shadow/Live-Fire",
      progress: 0.74,
      color: "purple",
      owner: ["luna", "sigma", "codex"]
    },
    %{
      id: "study-cafe",
      name: "스터디 카페 (스카팀)",
      path: "/Users/alexlee/projects/ai-agent-system/bots/ska",
      phase: "Phase 3",
      progress: 0.57,
      color: "blue",
      owner: ["ska", "jay"]
    }
  ]

  @task_titles [
    "권위 문서 통합 분석",
    "source path inventory",
    "project schema bootstrap",
    "LiveView area wiring",
    "Phase smoke 강화",
    "master visual validation",
    "handover evidence sync",
    "post-restart monitor",
    "risk banner polish",
    "timeline QA"
  ]

  def kanban_stages, do: @kanban_stages
  def stage_keys, do: @stage_keys
  def schema_objects, do: @schema_objects

  def config_path do
    repo_root =
      Application.get_env(:team_jay, :repo_root) ||
        System.get_env("REPO_ROOT") ||
        "/Users/alexlee/projects/ai-agent-system"

    Path.join(repo_root, "config/projects.yaml")
  end

  def snapshot(opts \\ []) do
    if Keyword.get(opts, :ensure_schema?, false), do: ensure_schema!()
    if Keyword.get(opts, :seed?, false), do: seed_marker_data!()

    schema_ready? = schema_ready?()
    projects = list_active_projects()
    tasks = list_tasks(projects)
    milestones = list_milestones(projects)
    active_sessions = list_active_sessions()
    tasks_by_stage = group_tasks_by_stage(tasks)
    metrics = build_metrics(projects, active_sessions, tasks_by_stage)

    %{
      schema_ready?: schema_ready?,
      config_path: config_path(),
      projects: projects,
      tasks: tasks,
      tasks_by_stage: tasks_by_stage,
      milestones: milestones,
      active_sessions: active_sessions,
      metrics: metrics,
      gantt: build_gantt(projects, tasks, milestones)
    }
  rescue
    error ->
      Logger.warning("[ProjectVisibility] snapshot fallback: #{inspect(error)}")
      fallback_snapshot(error)
  end

  def ensure_schema! do
    schema_sql()
    |> Enum.each(fn sql -> Repo.query!(sql, []) end)

    :ok
  end

  def schema_ready? do
    placeholders =
      @schema_objects
      |> Enum.with_index(1)
      |> Enum.map(fn {_object, idx} -> "to_regclass($#{idx}) IS NOT NULL" end)
      |> Enum.join(", ")

    case Repo.query("SELECT #{placeholders}", @schema_objects) do
      {:ok, %{rows: [row]}} -> Enum.all?(row)
      _ -> false
    end
  rescue
    _ -> false
  end

  def seed_marker_data! do
    ensure_schema!()
    projects = load_config_projects()
    tasks = marker_tasks(projects)
    milestones = marker_milestones(projects, tasks)
    sessions = marker_sessions(tasks)

    Enum.each(projects, &upsert_project!/1)
    Enum.each(tasks, &upsert_task!/1)
    Enum.each(milestones, &upsert_milestone!/1)
    Enum.each(sessions, &upsert_session!/1)

    %{
      projects: length(projects),
      tasks: length(tasks),
      milestones: length(milestones),
      sessions: length(sessions)
    }
  end

  def update_task_stage(task_id, stage) when stage in @stage_keys do
    sql = """
    UPDATE project.tasks
    SET stage = $2,
        finished_at = CASE WHEN $2 = 'done' THEN COALESCE(finished_at, NOW()) ELSE finished_at END,
        elapsed_seconds = CASE
          WHEN started_at IS NULL THEN elapsed_seconds
          ELSE GREATEST(EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::INT, 0)
        END
    WHERE id = $1
    RETURNING id, title, project_id, stage, assignee, started_at, finished_at,
              elapsed_seconds, source_doc, active_session_id, verify, observe
    """

    case Repo.query(sql, [to_string(task_id), stage]) do
      {:ok, %{rows: [row]}} ->
        task = row_to_task(row)
        broadcast_project_event("project.task.stage_changed", task)
        {:ok, task}

      {:ok, _} ->
        {:error, :not_found}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    error -> {:error, error}
  end

  def update_task_stage(_task_id, _stage), do: {:error, :invalid_stage}

  def marker_counts do
    projects = load_config_projects()
    tasks = marker_tasks(projects)
    milestones = marker_milestones(projects, tasks)

    %{projects: length(projects), tasks: length(tasks), milestones: length(milestones)}
  end

  defp schema_sql do
    [
      "CREATE SCHEMA IF NOT EXISTS project",
      """
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
      """,
      """
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
      """,
      """
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
      """,
      """
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
      """,
      """
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
      """,
      "CREATE INDEX IF NOT EXISTS idx_project_tasks_project_stage ON project.tasks(project_id, stage)",
      "CREATE INDEX IF NOT EXISTS idx_project_milestones_date ON project.milestones(date)",
      "CREATE INDEX IF NOT EXISTS idx_project_milestones_status ON project.milestones(status)",
      "CREATE INDEX IF NOT EXISTS idx_project_sessions_active ON project.sessions(ended_at) WHERE ended_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_project_metrics_date ON project.metrics(metric_date, created_at DESC)"
    ]
  end

  defp load_config_projects do
    case YamlElixir.read_from_file(config_path()) do
      {:ok, %{"included" => projects}} when is_list(projects) ->
        projects
        |> Enum.map(&normalize_project/1)
        |> Enum.reject(&(&1.id == ""))

      _ ->
        @default_projects
        |> Enum.map(&normalize_project/1)
    end
  rescue
    _ ->
      @default_projects
      |> Enum.map(&normalize_project/1)
  end

  defp normalize_project(project) when is_map(project) do
    id = string_value(project["id"] || project[:id])
    defaults = Enum.find(@default_projects, &(&1.id == id)) || %{}

    %{
      id: id,
      name: string_value(project["name"] || project[:name] || defaults[:name] || id),
      path: string_value(project["path"] || project[:path] || defaults[:path] || ""),
      github: nullable_string(project["github"] || project[:github] || defaults[:github]),
      phase: string_value(project["phase"] || project[:phase] || defaults[:phase] || "Phase G"),
      progress:
        clamp_progress(project["progress"] || project[:progress] || defaults[:progress] || 0.5),
      color: string_value(project["color"] || project[:color] || defaults[:color] || "gray"),
      status: string_value(project["status"] || project[:status] || "active"),
      owner: owner_list(project["owner"] || project[:owner] || defaults[:owner] || ["codex"]),
      last_activity: DateTime.utc_now()
    }
  end

  defp normalize_project(_), do: normalize_project(%{})

  defp list_active_projects do
    sql = """
    SELECT id, name, path, github, phase, progress::float, color, status, owner, last_activity
    FROM project.projects
    WHERE status = 'active'
    ORDER BY last_activity DESC NULLS LAST, id ASC
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: rows}} when rows != [] -> Enum.map(rows, &row_to_project/1)
      _ -> load_config_projects()
    end
  rescue
    _ -> load_config_projects()
  end

  defp list_tasks(projects) do
    project_ids = Enum.map(projects, & &1.id)

    sql = """
    SELECT id, title, project_id, stage, assignee, started_at, finished_at,
           elapsed_seconds, source_doc, active_session_id, verify, observe
    FROM project.tasks
    WHERE project_id = ANY($1::text[])
    ORDER BY started_at DESC NULLS LAST, id ASC
    LIMIT 200
    """

    case Repo.query(sql, [project_ids]) do
      {:ok, %{rows: rows}} when rows != [] -> Enum.map(rows, &row_to_task/1)
      _ -> marker_tasks(projects)
    end
  rescue
    _ -> marker_tasks(projects)
  end

  defp list_milestones(projects) do
    project_ids = Enum.map(projects, & &1.id)

    sql = """
    SELECT id, date, title, owner, task_ids, status, project_id, created_at
    FROM project.milestones
    WHERE project_id = ANY($1::text[])
      AND date >= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY date ASC, id ASC
    LIMIT 12
    """

    case Repo.query(sql, [project_ids]) do
      {:ok, %{rows: rows}} when rows != [] -> Enum.map(rows, &row_to_milestone/1)
      _ -> marker_milestones(projects, marker_tasks(projects))
    end
  rescue
    _ -> marker_milestones(projects, marker_tasks(projects))
  end

  defp list_active_sessions do
    sql = """
    SELECT id, agent_type, started_at, ended_at, task_ids, files_touched, handover_doc, summary
    FROM project.sessions
    WHERE ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 8
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: rows}} when rows != [] -> Enum.map(rows, &row_to_session/1)
      _ -> marker_sessions(marker_tasks(load_config_projects()))
    end
  rescue
    _ -> marker_sessions(marker_tasks(load_config_projects()))
  end

  defp marker_tasks(projects) do
    counts = [8, 8, 7, 7]
    now = DateTime.utc_now()

    projects
    |> Enum.with_index()
    |> Enum.flat_map(fn {project, project_idx} ->
      count = Enum.at(counts, project_idx, 6)

      0..(count - 1)
      |> Enum.map(fn task_idx ->
        stage = Enum.at(@stage_keys, rem(task_idx + project_idx, length(@stage_keys)))
        started_at = DateTime.add(now, -1 * (project_idx * 86_400 + task_idx * 7_200), :second)
        finished_at = if stage == "done", do: DateTime.add(started_at, 5_400, :second), else: nil
        title = Enum.at(@task_titles, task_idx, "visibility task #{task_idx + 1}")

        %{
          id: "#{project.id}-v33-#{task_idx + 1}",
          title: title,
          project_id: project.id,
          project_name: project.name,
          stage: stage,
          assignee:
            Enum.at(project.owner, rem(task_idx, max(length(project.owner), 1))) || "codex",
          started_at: started_at,
          finished_at: finished_at,
          elapsed_seconds:
            if(finished_at,
              do: DateTime.diff(finished_at, started_at, :second),
              else: DateTime.diff(now, started_at, :second)
            ),
          source_doc: "docs/strategy/VISIBILITY_SYSTEM_v3.3.md",
          active_session_id: "sess_v33_#{project_idx + 1}",
          verify: %{
            "runs" => task_idx + 1,
            "passed" => stage in ["verify", "observing", "done"],
            "failed" => 0
          },
          observe: %{
            "period_days" => 7,
            "day" => rem(task_idx, 7) + 1,
            "status" => if(stage == "observing", do: "watching", else: "pending"),
            "alerts" => []
          }
        }
      end)
    end)
    |> Enum.take(30)
  end

  defp marker_milestones(projects, tasks) do
    today = Date.utc_today()

    projects
    |> Enum.with_index()
    |> Enum.flat_map(fn {project, idx} ->
      project_task_ids =
        tasks
        |> Enum.filter(&(&1.project_id == project.id))
        |> Enum.map(& &1.id)
        |> Enum.take(4)

      [
        %{
          id: "#{project.id}-ms-v33-1",
          date: Date.add(today, 2 + idx * 2),
          title: "#{project.name} Phase G checkpoint",
          owner: Enum.at(project.owner, 0) || "codex",
          task_ids: Enum.take(project_task_ids, 2),
          status: "upcoming",
          project_id: project.id,
          created_at: DateTime.utc_now()
        },
        %{
          id: "#{project.id}-ms-v33-2",
          date: Date.add(today, 7 + idx * 2),
          title: "#{project.name} 2주 검증",
          owner: Enum.at(project.owner, 1) || Enum.at(project.owner, 0) || "codex",
          task_ids: project_task_ids,
          status: "upcoming",
          project_id: project.id,
          created_at: DateTime.utc_now()
        }
      ]
    end)
    |> Enum.take(8)
  end

  defp marker_sessions(tasks) do
    now = DateTime.utc_now()

    [
      %{
        id: "sess_v33_metty",
        agent_type: "metty",
        started_at: DateTime.add(now, -3_600, :second),
        ended_at: nil,
        task_ids: tasks |> Enum.take(3) |> Enum.map(& &1.id),
        files_touched: ["docs/strategy/VISIBILITY_SYSTEM_v3.3.md"],
        handover_doc: "docs/strategy/VISIBILITY_SYSTEM_v3.3.md",
        summary: "v3.3 권위 문서 및 Phase G 인계"
      },
      %{
        id: "sess_v33_codex",
        agent_type: "codex",
        started_at: DateTime.add(now, -1_800, :second),
        ended_at: nil,
        task_ids: tasks |> Enum.drop(3) |> Enum.take(4) |> Enum.map(& &1.id),
        files_touched: ["elixir/team_jay/lib/team_jay/dashboard/live/dashboard_live.ex"],
        handover_doc: nil,
        summary: "영역 10/11 구현"
      }
    ]
  end

  defp group_tasks_by_stage(tasks) do
    base = Map.new(@stage_keys, &{&1, []})

    tasks
    |> Enum.group_by(& &1.stage)
    |> then(&Map.merge(base, &1))
  end

  defp build_metrics(projects, sessions, tasks_by_stage) do
    by_stage = Map.new(@stage_keys, &{&1, length(Map.get(tasks_by_stage, &1, []))})

    %{
      active_projects: length(projects),
      active_sessions: length(sessions),
      by_stage: by_stage,
      observe_warnings: count_observe_warnings(Map.get(tasks_by_stage, "observing", [])),
      conflicts: count_session_conflicts(sessions)
    }
  end

  defp build_gantt(projects, tasks, milestones) do
    start_date = Date.utc_today()
    dates = Enum.map(0..14, &Date.add(start_date, &1))
    end_date = List.last(dates)

    %{
      start_date: start_date,
      end_date: end_date,
      dates: dates,
      projects: projects,
      tasks_by_project: Enum.group_by(tasks, & &1.project_id),
      milestones_by_project: Enum.group_by(milestones, & &1.project_id)
    }
  end

  defp fallback_snapshot(reason) do
    projects = load_config_projects()
    tasks = marker_tasks(projects)
    milestones = marker_milestones(projects, tasks)
    sessions = marker_sessions(tasks)
    tasks_by_stage = group_tasks_by_stage(tasks)

    %{
      schema_ready?: false,
      config_path: config_path(),
      projects: projects,
      tasks: tasks,
      tasks_by_stage: tasks_by_stage,
      milestones: milestones,
      active_sessions: sessions,
      metrics: build_metrics(projects, sessions, tasks_by_stage),
      gantt: build_gantt(projects, tasks, milestones),
      error: inspect(reason)
    }
  end

  defp row_to_project([
         id,
         name,
         path,
         github,
         phase,
         progress,
         color,
         status,
         owner,
         last_activity
       ]) do
    %{
      id: id,
      name: name,
      path: path,
      github: github,
      phase: phase,
      progress: clamp_progress(progress || 0),
      color: color || "gray",
      status: status || "active",
      owner: owner || [],
      last_activity: last_activity
    }
  end

  defp row_to_task([
         id,
         title,
         project_id,
         stage,
         assignee,
         started_at,
         finished_at,
         elapsed_seconds,
         source_doc,
         active_session_id,
         verify,
         observe
       ]) do
    %{
      id: id,
      title: title,
      project_id: project_id,
      project_name: project_id,
      stage: stage || "spec",
      assignee: assignee,
      started_at: started_at,
      finished_at: finished_at,
      elapsed_seconds: elapsed_seconds,
      source_doc: source_doc,
      active_session_id: active_session_id,
      verify: verify || %{},
      observe: observe || %{}
    }
  end

  defp row_to_milestone([id, date, title, owner, task_ids, status, project_id, created_at]) do
    %{
      id: id,
      date: date,
      title: title,
      owner: owner,
      task_ids: task_ids || [],
      status: status || "upcoming",
      project_id: project_id,
      created_at: created_at
    }
  end

  defp row_to_session([
         id,
         agent_type,
         started_at,
         ended_at,
         task_ids,
         files_touched,
         handover_doc,
         summary
       ]) do
    %{
      id: id,
      agent_type: agent_type,
      started_at: started_at,
      ended_at: ended_at,
      task_ids: task_ids || [],
      files_touched: files_touched || [],
      handover_doc: handover_doc,
      summary: summary
    }
  end

  defp upsert_project!(project) do
    Repo.query!(
      """
      INSERT INTO project.projects
        (id, name, path, github, phase, progress, color, status, owner, last_activity)
      VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::text[], NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        path = EXCLUDED.path,
        github = EXCLUDED.github,
        phase = EXCLUDED.phase,
        progress = EXCLUDED.progress,
        color = EXCLUDED.color,
        status = EXCLUDED.status,
        owner = EXCLUDED.owner,
        last_activity = NOW()
      """,
      [
        project.id,
        project.name,
        project.path,
        project.github,
        project.phase,
        project.progress,
        project.color,
        project.status,
        project.owner
      ]
    )
  end

  defp upsert_task!(task) do
    Repo.query!(
      """
      INSERT INTO project.tasks
        (id, title, project_id, stage, assignee, started_at, finished_at, elapsed_seconds,
         source_doc, active_session_id, verify, observe)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        project_id = EXCLUDED.project_id,
        stage = EXCLUDED.stage,
        assignee = EXCLUDED.assignee,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        elapsed_seconds = EXCLUDED.elapsed_seconds,
        source_doc = EXCLUDED.source_doc,
        active_session_id = EXCLUDED.active_session_id,
        verify = EXCLUDED.verify,
        observe = EXCLUDED.observe
      """,
      [
        task.id,
        task.title,
        task.project_id,
        task.stage,
        task.assignee,
        task.started_at,
        task.finished_at,
        task.elapsed_seconds,
        task.source_doc,
        task.active_session_id,
        Jason.encode!(task.verify || %{}),
        Jason.encode!(task.observe || %{})
      ]
    )
  end

  defp upsert_milestone!(milestone) do
    Repo.query!(
      """
      INSERT INTO project.milestones
        (id, date, title, owner, task_ids, status, project_id, created_at)
      VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        date = EXCLUDED.date,
        title = EXCLUDED.title,
        owner = EXCLUDED.owner,
        task_ids = EXCLUDED.task_ids,
        status = EXCLUDED.status,
        project_id = EXCLUDED.project_id
      """,
      [
        milestone.id,
        milestone.date,
        milestone.title,
        milestone.owner,
        milestone.task_ids,
        milestone.status,
        milestone.project_id,
        milestone.created_at
      ]
    )
  end

  defp upsert_session!(session) do
    Repo.query!(
      """
      INSERT INTO project.sessions
        (id, agent_type, started_at, ended_at, task_ids, files_touched, handover_doc, summary)
      VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        agent_type = EXCLUDED.agent_type,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        task_ids = EXCLUDED.task_ids,
        files_touched = EXCLUDED.files_touched,
        handover_doc = EXCLUDED.handover_doc,
        summary = EXCLUDED.summary
      """,
      [
        session.id,
        session.agent_type,
        session.started_at,
        session.ended_at,
        session.task_ids,
        session.files_touched,
        session.handover_doc,
        session.summary
      ]
    )
  end

  defp broadcast_project_event(topic, task) do
    Phoenix.PubSub.broadcast(TeamJay.PubSub, "project:visibility", {:project_event, topic, task})
    Jay.Core.JayBus.publish(topic, task)
  rescue
    _ -> :ok
  end

  defp count_observe_warnings(tasks) do
    Enum.count(tasks, fn task ->
      alerts = get_in(task, [:observe, "alerts"]) || get_in(task, [:observe, :alerts]) || []
      alerts != []
    end)
  end

  defp count_session_conflicts(sessions) do
    sessions
    |> Enum.flat_map(&(&1.files_touched || []))
    |> Enum.frequencies()
    |> Enum.count(fn {_file, count} -> count > 1 end)
  end

  defp owner_list(value) when is_list(value), do: Enum.map(value, &to_string/1)
  defp owner_list(value) when is_binary(value), do: [value]
  defp owner_list(_), do: []

  defp string_value(nil), do: ""
  defp string_value(value), do: to_string(value)

  defp nullable_string(nil), do: nil
  defp nullable_string(""), do: nil
  defp nullable_string(value), do: to_string(value)

  defp clamp_progress(%Decimal{} = value), do: value |> Decimal.to_float() |> clamp_progress()
  defp clamp_progress(value) when is_float(value), do: min(max(value, 0.0), 1.0)
  defp clamp_progress(value) when is_integer(value), do: value |> Kernel./(1) |> clamp_progress()

  defp clamp_progress(value) when is_binary(value) do
    case Float.parse(value) do
      {number, _} -> clamp_progress(number)
      _ -> 0.0
    end
  end

  defp clamp_progress(_), do: 0.0
end
