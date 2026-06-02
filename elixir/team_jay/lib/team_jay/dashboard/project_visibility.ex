defmodule TeamJay.Dashboard.ProjectVisibility do
  @moduledoc """
  Visibility v3.4 project/milestone/timeline data adapter.

  The dashboard can render from PostgreSQL when the `project` schema exists,
  and falls back to deterministic marker data so area 10/11 remain visible
  before production seed data is applied.
  """

  require Logger

  alias Jay.Core.Repo
  alias TeamJay.Dashboard.SessionTracker

  @kst_offset_seconds 9 * 60 * 60
  @visibility_doc_path "docs/strategy/VISIBILITY_SYSTEM_v3.4.md"
  @stage_keys ~w(spec building verify observing done)
  @stale_task_days 3
  @upcoming_milestone_days 7
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
    action_items = build_action_items(tasks, milestones)
    metrics = build_metrics(projects, active_sessions, tasks_by_stage, milestones, action_items)

    %{
      schema_ready?: schema_ready?,
      config_path: config_path(),
      projects: projects,
      tasks: tasks,
      tasks_by_stage: tasks_by_stage,
      milestones: milestones,
      action_items: action_items,
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

  def ingest_event(event) when is_map(event) do
    event_type = map_value(event, :event_type, "")
    metadata = map_value(event, :metadata, %{}) |> ensure_map()

    cond do
      String.starts_with?(event_type, "codex.task.") ->
        ingest_codex_task_event(event_type, event, metadata)

      String.starts_with?(event_type, "project.task.") ->
        ingest_project_task_event(event_type, event, metadata)

      String.starts_with?(event_type, "project.milestone.") ->
        ingest_project_milestone_event(event_type, event, metadata)

      true ->
        :ignored
    end
  end

  def ingest_event(_), do: :ignored

  def ingest_recent_event_lake_tasks!(opts \\ []) do
    ensure_schema_cached!()
    limit = Keyword.get(opts, :limit, 200)

    sql = """
    SELECT event_type, team, bot_name, severity, trace_id, title, message, tags, metadata, created_at
    FROM agent.event_lake
    WHERE event_type LIKE 'codex.task.%'
       OR event_type LIKE 'project.task.%'
       OR event_type LIKE 'project.milestone.%'
    ORDER BY created_at DESC
    LIMIT $1
    """

    case Repo.query(sql, [limit]) do
      {:ok, %{rows: rows}} ->
        Enum.reduce(rows, %{checked: 0, ingested: 0, ignored: 0, failed: 0}, fn row, acc ->
          event = row_to_event(row)

          case ingest_event(event) do
            {:ok, _} -> %{acc | checked: acc.checked + 1, ingested: acc.ingested + 1}
            :ignored -> %{acc | checked: acc.checked + 1, ignored: acc.ignored + 1}
            {:error, _} -> %{acc | checked: acc.checked + 1, failed: acc.failed + 1}
          end
        end)

      {:error, reason} ->
        %{checked: 0, ingested: 0, ignored: 0, failed: 1, error: inspect(reason)}
    end
  rescue
    error -> %{checked: 0, ingested: 0, ignored: 0, failed: 1, error: inspect(error)}
  end

  def ingest_task!(attrs) when is_map(attrs) do
    ensure_schema_cached!()
    project = project_for_event(attrs)
    task = normalize_ingested_task(attrs, project)

    upsert_project!(project)
    upsert_task!(task)
    broadcast_project_event("project.task.created", task)
    {:ok, task}
  rescue
    error -> {:error, error}
  end

  def reconcile_milestone_statuses! do
    ensure_schema_cached!()

    sql = """
    SELECT id, date, title, owner, task_ids, status, project_id, created_at
    FROM project.milestones
    ORDER BY date ASC, id ASC
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        rows
        |> Enum.map(&row_to_milestone/1)
        |> Enum.reduce(
          %{checked: 0, changed: 0, achieved: 0, missed: 0, upcoming: 0},
          fn milestone, acc ->
            new_status = milestone_reconciled_status(milestone)

            if new_status == milestone.status do
              %{acc | checked: acc.checked + 1}
            else
              update_milestone_status!(milestone, new_status)

              acc
              |> Map.update!(:checked, &(&1 + 1))
              |> Map.update!(:changed, &(&1 + 1))
              |> Map.update(status_counter_key(new_status), 1, &(&1 + 1))
            end
          end
        )

      {:error, reason} ->
        %{checked: 0, changed: 0, achieved: 0, missed: 0, upcoming: 0, error: inspect(reason)}
    end
  rescue
    error -> %{checked: 0, changed: 0, achieved: 0, missed: 0, upcoming: 0, error: inspect(error)}
  end

  def marker_counts do
    projects = load_config_projects()
    tasks = marker_tasks(projects)
    milestones = marker_milestones(projects, tasks)

    %{projects: length(projects), tasks: length(tasks), milestones: length(milestones)}
  end

  def build_action_items(tasks, milestones, opts \\ []) do
    stale_days = Keyword.get(opts, :stale_days, @stale_task_days)
    upcoming_days = Keyword.get(opts, :upcoming_days, @upcoming_milestone_days)
    today = kst_today()
    tasks_by_id = Map.new(tasks, &{&1.id, &1})

    milestone_items =
      milestones
      |> Enum.flat_map(fn milestone ->
        due_in_days = Date.diff(date_value(milestone.date) || today, today)

        kind =
          cond do
            milestone.status == "missed" ->
              "missed_milestone"

            milestone.status != "achieved" and due_in_days >= 0 and due_in_days <= upcoming_days ->
              "upcoming_milestone"

            true ->
              nil
          end

        if kind do
          milestone.task_ids
          |> Enum.map(&Map.get(tasks_by_id, &1))
          |> Enum.reject(&is_nil/1)
          |> Enum.reject(&(&1.stage == "done"))
          |> Enum.map(fn task ->
            action_item(task, %{
              kind: kind,
              priority: action_priority(kind, due_in_days, task),
              due_in_days: due_in_days,
              milestone_id: milestone.id,
              milestone_title: milestone.title,
              milestone_date: milestone.date,
              milestone_status: milestone.status,
              reason: action_reason(kind, due_in_days)
            })
          end)
        else
          []
        end
      end)

    milestone_task_ids = MapSet.new(Enum.map(milestone_items, & &1.task_id))

    stale_items =
      tasks
      |> Enum.reject(&(&1.stage == "done"))
      |> Enum.reject(&MapSet.member?(milestone_task_ids, &1.id))
      |> Enum.filter(&(age_days(&1.started_at) >= stale_days))
      |> Enum.map(fn task ->
        task_age_days = age_days(task.started_at)

        action_item(task, %{
          kind: "stale_task",
          priority: 80 + min(task_age_days, 30),
          due_in_days: nil,
          milestone_id: nil,
          milestone_title: nil,
          milestone_date: nil,
          milestone_status: nil,
          reason: "#{task_age_days}일 이상 #{task.stage} 상태"
        })
      end)

    (milestone_items ++ stale_items)
    |> Enum.sort_by(
      &{-&1.priority, &1.due_in_days || 999, -&1.age_days, &1.project_id, &1.task_id}
    )
    |> Enum.take(12)
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
      AND date >= CURRENT_DATE - INTERVAL '14 days'
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
          source_doc: @visibility_doc_path,
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
    today = kst_today()

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
        files_touched: [@visibility_doc_path],
        handover_doc: @visibility_doc_path,
        summary: "v3.4 권위 문서 및 Phase G 인계"
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

  defp build_metrics(projects, sessions, tasks_by_stage, milestones, action_items) do
    by_stage = Map.new(@stage_keys, &{&1, length(Map.get(tasks_by_stage, &1, []))})

    %{
      active_projects: length(projects),
      active_sessions: length(sessions),
      by_stage: by_stage,
      observe_warnings: count_observe_warnings(Map.get(tasks_by_stage, "observing", [])),
      conflicts: SessionTracker.count_conflicts(sessions),
      action_items: length(action_items),
      missed_milestones: Enum.count(milestones, &(&1.status == "missed")),
      stale_building_tasks: Enum.count(action_items, &(&1.kind == "stale_task"))
    }
  end

  defp build_gantt(projects, tasks, milestones) do
    start_date = kst_today()
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
    action_items = build_action_items(tasks, milestones)

    %{
      schema_ready?: false,
      config_path: config_path(),
      projects: projects,
      tasks: tasks,
      tasks_by_stage: tasks_by_stage,
      milestones: milestones,
      action_items: action_items,
      active_sessions: sessions,
      metrics: build_metrics(projects, sessions, tasks_by_stage, milestones, action_items),
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
      verify: json_map(verify),
      observe: json_map(observe)
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

  def upsert_project!(project) do
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

  def upsert_task!(task) do
    Repo.query!(
      """
      INSERT INTO project.tasks
        (id, title, project_id, stage, assignee, started_at, finished_at, elapsed_seconds,
         source_doc, active_session_id, verify, observe)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        project_id = EXCLUDED.project_id,
        stage = CASE
          WHEN project.tasks.stage = 'done' AND EXCLUDED.stage <> 'done' THEN project.tasks.stage
          ELSE EXCLUDED.stage
        END,
        assignee = EXCLUDED.assignee,
        started_at = EXCLUDED.started_at,
        finished_at = CASE
          WHEN project.tasks.stage = 'done' AND EXCLUDED.stage <> 'done' THEN project.tasks.finished_at
          ELSE EXCLUDED.finished_at
        END,
        elapsed_seconds = CASE
          WHEN project.tasks.stage = 'done' AND EXCLUDED.stage <> 'done' THEN project.tasks.elapsed_seconds
          ELSE EXCLUDED.elapsed_seconds
        END,
        source_doc = EXCLUDED.source_doc,
        active_session_id = EXCLUDED.active_session_id,
        verify = CASE
          WHEN project.tasks.stage = 'done' AND EXCLUDED.stage <> 'done' THEN project.tasks.verify
          ELSE EXCLUDED.verify
        END,
        observe = CASE
          WHEN project.tasks.stage = 'done' AND EXCLUDED.stage <> 'done' THEN project.tasks.observe
          ELSE EXCLUDED.observe
        END
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

  def upsert_milestone!(milestone) do
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

  def upsert_session!(session) do
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

  defp ingest_codex_task_event(event_type, event, metadata) do
    source_doc =
      map_value(metadata, :file_path) ||
        infer_codex_source_doc(event) ||
        "agent.event_lake"

    if missing_codex_source_doc?(source_doc) do
      Logger.info("[ProjectVisibility] ignore stale codex task event without source_doc=#{source_doc}")
      :ignored
    else
      ingest_codex_task_event_with_source(event_type, event, metadata, source_doc)
    end
  end

  defp ingest_codex_task_event_with_source(event_type, event, metadata, source_doc) do
    stage =
      cond do
        String.ends_with?(event_type, ".archived") ->
          "done"

        complete_checklist?(metadata) ->
          "verify"

        true ->
          "building"
      end

    attrs = %{
      id: map_value(metadata, :task_id) || event_slug(event),
      title: map_value(event, :title, "코덱스 작업"),
      project_id: project_id_from_path(source_doc),
      stage: stage,
      assignee: "codex",
      source_doc: source_doc,
      started_at: map_value(event, :created_at) || map_value(metadata, :observed_at),
      finished_at: if(stage == "done", do: DateTime.utc_now(), else: nil),
      verify: %{
        "source_event" => event_type,
        "total_checkboxes" => map_value(metadata, :total_checkboxes, 0),
        "checked" => map_value(metadata, :checked, 0)
      },
      observe: %{
        "cycle_id" => map_value(metadata, :cycle_id),
        "trace_id" => map_value(event, :trace_id, "")
      }
    }

    with {:ok, task} <- ingest_task!(attrs) do
      broadcast_project_event("project.task.stage_changed", task)
      {:ok, task}
    end
  end

  defp missing_codex_source_doc?(source_doc) do
    source_doc = to_string(source_doc || "")

    String.starts_with?(source_doc, "docs/codex/") and
      not File.exists?(Path.join(repo_root(), source_doc))
  end

  defp infer_codex_source_doc(event) do
    text = "#{map_value(event, :title, "")} #{map_value(event, :message, "")}"

    case Regex.run(~r/\b(CODEX_[A-Z0-9_-]+(?:_\d{4}-\d{2}-\d{2})?\.md)\b/u, text) do
      [_, filename] -> "docs/codex/#{filename}"
      _ -> nil
    end
  end

  defp repo_root do
    Application.get_env(:team_jay, :repo_root) ||
      System.get_env("REPO_ROOT") ||
      "/Users/alexlee/projects/ai-agent-system"
  end

  defp ingest_project_task_event(event_type, event, metadata) do
    attrs =
      metadata
      |> Map.merge(%{
        id: map_value(metadata, :id) || map_value(metadata, :task_id) || event_slug(event),
        title: map_value(metadata, :title, map_value(event, :title, "project task")),
        project_id: map_value(metadata, :project_id, "ai-agent-system"),
        stage: project_task_stage(event_type, metadata),
        source_doc: map_value(metadata, :source_doc, "project.task event")
      })

    ingest_task!(attrs)
  end

  defp ingest_project_milestone_event(event_type, event, metadata) do
    ensure_schema_cached!()
    project = project_for_event(metadata)

    milestone = %{
      id: map_value(metadata, :id) || map_value(metadata, :milestone_id) || event_slug(event),
      date: parse_date(map_value(metadata, :date)) || kst_today(),
      title: map_value(metadata, :title, map_value(event, :title, "project milestone")),
      owner: map_value(metadata, :owner, "codex"),
      task_ids: list_value(map_value(metadata, :task_ids, [])),
      status: milestone_event_status(event_type, metadata),
      project_id: project.id,
      created_at: DateTime.utc_now()
    }

    upsert_project!(project)
    upsert_milestone!(milestone)
    broadcast_project_event(milestone_event_topic(milestone.status), milestone)
    {:ok, milestone}
  rescue
    error -> {:error, error}
  end

  defp project_for_event(attrs) do
    project_id =
      map_value(attrs, :project_id) || project_id_from_path(map_value(attrs, :source_doc, ""))

    load_config_projects()
    |> Enum.find(&(&1.id == project_id))
    |> Kernel.||(
      load_config_projects()
      |> Enum.find(&(&1.id == "ai-agent-system"))
    )
    |> Kernel.||(%{
      id: "ai-agent-system",
      name: "팀 제이 (ai-agent-system)",
      path: "/Users/alexlee/projects/ai-agent-system",
      github: nil,
      phase: "Phase G",
      progress: 0.82,
      color: "green",
      status: "active",
      owner: ["codex"],
      last_activity: DateTime.utc_now()
    })
  end

  defp normalize_ingested_task(attrs, project) do
    stage = map_value(attrs, :stage, "spec")
    started_at = parse_datetime(map_value(attrs, :started_at)) || DateTime.utc_now()
    finished_at = parse_datetime(map_value(attrs, :finished_at))

    %{
      id: "evt-#{safe_id(map_value(attrs, :id, event_fallback_id(attrs)))}",
      title: map_value(attrs, :title, "project task"),
      project_id: project.id,
      project_name: project.name,
      stage: if(stage in @stage_keys, do: stage, else: "spec"),
      assignee: map_value(attrs, :assignee, "codex"),
      started_at: started_at,
      finished_at: finished_at,
      elapsed_seconds: elapsed_seconds(started_at, finished_at),
      source_doc: map_value(attrs, :source_doc, "event_lake"),
      active_session_id: map_value(attrs, :active_session_id),
      verify: ensure_map(map_value(attrs, :verify, %{})),
      observe: ensure_map(map_value(attrs, :observe, %{}))
    }
  end

  defp row_to_event([
         event_type,
         team,
         bot_name,
         severity,
         trace_id,
         title,
         message,
         tags,
         metadata,
         created_at
       ]) do
    %{
      "event_type" => event_type,
      "team" => team,
      "bot_name" => bot_name,
      "severity" => severity,
      "trace_id" => trace_id,
      "title" => title,
      "message" => message,
      "tags" => tags || [],
      "metadata" => metadata || %{},
      "created_at" => created_at
    }
  end

  defp milestone_reconciled_status(%{status: "achieved"}), do: "achieved"

  defp milestone_reconciled_status(%{date: date, task_ids: task_ids} = milestone) do
    done? = task_ids != [] and all_milestone_tasks_done?(task_ids)

    cond do
      done? -> "achieved"
      overdue?(date) -> "missed"
      true -> milestone.status || "upcoming"
    end
  end

  defp all_milestone_tasks_done?(task_ids) do
    case Repo.query("SELECT stage FROM project.tasks WHERE id = ANY($1::text[])", [task_ids]) do
      {:ok, %{rows: rows}} when length(rows) == length(task_ids) and rows != [] ->
        Enum.all?(rows, fn [stage] -> stage == "done" end)

      _ ->
        false
    end
  rescue
    _ -> false
  end

  defp update_milestone_status!(milestone, status) do
    Repo.query!(
      "UPDATE project.milestones SET status = $2 WHERE id = $1",
      [milestone.id, status]
    )

    updated = %{milestone | status: status}

    topic =
      if(status == "achieved", do: "project.milestone.achieved", else: "project.milestone.missed")

    broadcast_project_event(topic, updated)
  end

  defp complete_checklist?(metadata) do
    total = integer_value(map_value(metadata, :total_checkboxes, 0))
    checked = integer_value(map_value(metadata, :checked, 0))
    total > 0 and checked >= total
  end

  defp project_task_stage(event_type, metadata) do
    stage = map_value(metadata, :stage)

    cond do
      stage in @stage_keys -> stage
      String.ends_with?(event_type, ".stage_changed") -> "building"
      String.ends_with?(event_type, ".created") -> "spec"
      true -> "building"
    end
  end

  defp milestone_event_status(event_type, metadata) do
    status = map_value(metadata, :status)

    cond do
      status in ["upcoming", "achieved", "missed"] -> status
      String.ends_with?(event_type, ".achieved") -> "achieved"
      String.ends_with?(event_type, ".missed") -> "missed"
      true -> "upcoming"
    end
  end

  defp milestone_event_topic("achieved"), do: "project.milestone.achieved"
  defp milestone_event_topic("missed"), do: "project.milestone.missed"
  defp milestone_event_topic(_), do: "project.milestone.added"

  defp action_item(task, meta) do
    %{
      kind: meta.kind,
      priority: meta.priority,
      reason: meta.reason,
      task_id: task.id,
      title: task.title,
      project_id: task.project_id,
      stage: task.stage,
      assignee: task.assignee,
      source_doc: task.source_doc,
      started_at: task.started_at,
      age_days: age_days(task.started_at),
      due_in_days: meta.due_in_days,
      milestone_id: meta.milestone_id,
      milestone_title: meta.milestone_title,
      milestone_date: meta.milestone_date,
      milestone_status: meta.milestone_status
    }
  end

  defp action_priority("missed_milestone", _due_in_days, _task), do: 300
  defp action_priority("upcoming_milestone", due_in_days, _task), do: 200 - max(due_in_days, 0)
  defp action_priority(_, _due_in_days, task), do: 80 + min(age_days(task.started_at), 30)

  defp action_reason("missed_milestone", _due_in_days), do: "기한 경과 마일스톤 미완료"
  defp action_reason("upcoming_milestone", 0), do: "오늘 마감 마일스톤"
  defp action_reason("upcoming_milestone", due_in_days), do: "#{due_in_days}일 후 마감 마일스톤"
  defp action_reason(_, _), do: "진행 상태 점검 필요"

  defp ensure_schema_cached! do
    unless Process.get(:team_jay_project_visibility_schema_ready) == true do
      ensure_schema!()
      Process.put(:team_jay_project_visibility_schema_ready, true)
    end

    :ok
  end

  defp project_id_from_path(path) when is_binary(path) do
    cond do
      String.contains?(path, "bots/blog") -> "blog-automation"
      String.contains?(path, "bots/investment") -> "luna-autonomy"
      String.contains?(path, "bots/ska") -> "study-cafe"
      true -> "ai-agent-system"
    end
  end

  defp project_id_from_path(_), do: "ai-agent-system"

  defp event_slug(event) do
    [
      map_value(event, :event_type, "event"),
      map_value(event, :title, "task"),
      map_value(event, :created_at, DateTime.utc_now() |> DateTime.to_iso8601())
    ]
    |> Enum.join("-")
    |> safe_id()
  end

  defp event_fallback_id(attrs) do
    [map_value(attrs, :project_id, "project"), map_value(attrs, :title, "task")]
    |> Enum.join("-")
  end

  defp safe_id(value) do
    value
    |> to_string()
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9가-힣_-]+/u, "-")
    |> String.trim("-")
    |> String.slice(0, 96)
    |> then(fn
      "" -> "task"
      id -> id
    end)
  end

  defp map_value(map, key, default \\ nil)

  defp map_value(map, key, default) when is_map(map) do
    Map.get(map, key, Map.get(map, Atom.to_string(key), default))
  end

  defp map_value(_, _, default), do: default

  defp ensure_map(value) when is_map(value), do: value
  defp ensure_map(_), do: %{}

  defp json_map(value) when is_map(value), do: value

  defp json_map(value) when is_binary(value) do
    case Jason.decode(value) do
      {:ok, decoded} when is_map(decoded) -> decoded
      _ -> %{}
    end
  end

  defp json_map(_), do: %{}

  defp list_value(value) when is_list(value), do: Enum.map(value, &to_string/1)
  defp list_value(value) when is_binary(value), do: [value]
  defp list_value(_), do: []

  defp integer_value(value) when is_integer(value), do: value

  defp integer_value(value) when is_binary(value) do
    case Integer.parse(value) do
      {number, _} -> number
      _ -> 0
    end
  end

  defp integer_value(_), do: 0

  defp parse_datetime(%DateTime{} = value), do: value
  defp parse_datetime(%NaiveDateTime{} = value), do: DateTime.from_naive!(value, "Etc/UTC")

  defp parse_datetime(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _} -> dt
      _ -> nil
    end
  end

  defp parse_datetime(_), do: nil

  defp parse_date(%Date{} = value), do: value

  defp parse_date(value) when is_binary(value) do
    case Date.from_iso8601(value) do
      {:ok, date} -> date
      _ -> nil
    end
  end

  defp parse_date(_), do: nil

  defp date_value(%Date{} = value), do: value
  defp date_value(%NaiveDateTime{} = value), do: NaiveDateTime.to_date(value)
  defp date_value(%DateTime{} = value), do: DateTime.to_date(value)
  defp date_value(value) when is_binary(value), do: parse_date(value)
  defp date_value(_), do: nil

  defp elapsed_seconds(started_at, nil),
    do: DateTime.diff(DateTime.utc_now(), started_at, :second)

  defp elapsed_seconds(started_at, finished_at),
    do: DateTime.diff(finished_at, started_at, :second)

  defp overdue?(%Date{} = date), do: Date.compare(date, kst_today()) == :lt
  defp overdue?(_), do: false

  defp age_days(value) do
    started_at = parse_datetime(value) || DateTime.utc_now()
    max(div(DateTime.diff(DateTime.utc_now(), started_at, :second), 86_400), 0)
  rescue
    _ -> 0
  end

  defp kst_today do
    DateTime.utc_now()
    |> DateTime.add(@kst_offset_seconds, :second)
    |> DateTime.to_date()
  end

  defp status_counter_key("achieved"), do: :achieved
  defp status_counter_key("missed"), do: :missed
  defp status_counter_key(_), do: :upcoming

  defp count_observe_warnings(tasks) do
    Enum.count(tasks, fn task ->
      observe = task[:observe] || %{}
      alerts = Map.get(observe, "alerts") || Map.get(observe, :alerts) || []
      alerts != []
    end)
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
