defmodule Mix.Tasks.Blog.Phase3.Backfill do
  use Mix.Task

  @shortdoc "blog_post_published 이벤트를 기반으로 Phase 3 feedback 이벤트를 backfill합니다"
  @requirements ["app.start"]

  @moduledoc """
  기존 blog_post_published 이벤트를 읽어
  누락된 blog_feedback_created 이벤트를 채운다.

  ## Examples

      mix blog.phase3.backfill
      mix blog.phase3.backfill --json
      mix blog.phase3.backfill --dry-run --json
  """

  alias Ecto.Adapters.SQL
  alias Jay.Core.Repo
  alias Jay.Core.Schemas.EventLake

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args, strict: [json: :boolean, dry_run: :boolean])

    dry_run? = Keyword.get(opts, :dry_run, false)
    events = load_candidates()

    {inserted, skipped, prepared} =
      Enum.reduce(events, {0, 0, []}, fn event, {inserted_acc, skipped_acc, prepared_acc} ->
        if feedback_exists?(event.feedback_key) do
          {inserted_acc, skipped_acc + 1, prepared_acc}
        else
          if dry_run? do
            {inserted_acc, skipped_acc, [event | prepared_acc]}
          else
            insert_feedback_event!(event)
            {inserted_acc + 1, skipped_acc, [event | prepared_acc]}
          end
        end
      end)

    result = %{
      scanned: length(events),
      inserted: inserted,
      skipped: skipped,
      dry_run: dry_run?,
      prepared: Enum.reverse(prepared) |> Enum.take(5)
    }

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode!(result))
    else
      Mix.shell().info("Blog Phase 3 Backfill")
      Mix.shell().info("scanned=#{result.scanned} inserted=#{result.inserted} skipped=#{result.skipped} dry_run=#{result.dry_run}")
    end
  end

  defp load_candidates do
    {:ok, result} =
      SQL.query(
        Repo,
        """
        SELECT
          created_at,
          title,
          metadata->>'postId' AS post_id,
          metadata->>'postType' AS post_type,
          metadata->>'writerName' AS writer_name,
          metadata->>'category' AS category
        FROM agent.event_lake
        WHERE team = 'blog'
          AND event_type = 'blog_post_published'
        ORDER BY created_at DESC
        """,
        []
      )

    Enum.map(result.rows, fn row ->
      row
      |> Enum.zip(result.columns)
      |> Map.new(fn {value, key} -> {String.to_atom(key), value} end)
      |> normalize_candidate()
    end)
  end

  defp normalize_candidate(candidate) do
    created_at = Map.get(candidate, :created_at)
    writer = Map.get(candidate, :writer_name) || "unknown"
    post_type = Map.get(candidate, :post_type) || "unknown"
    date =
      created_at
      |> DateTime.from_naive!("Etc/UTC")
      |> DateTime.to_date()
      |> Date.to_iso8601()

    %{
      feedback_key: "#{post_type}:#{date}:#{writer}",
      title: Map.get(candidate, :title),
      post_id: parse_int(Map.get(candidate, :post_id)),
      post_type: post_type,
      writer: writer,
      category: Map.get(candidate, :category),
      created_at: created_at,
      note: "Backfilled from blog_post_published"
    }
  rescue
    _ ->
      %{
        feedback_key: "unknown:unknown:unknown",
        title: Map.get(candidate, :title),
        post_id: parse_int(Map.get(candidate, :post_id)),
        post_type: Map.get(candidate, :post_type) || "unknown",
        writer: Map.get(candidate, :writer_name) || "unknown",
        category: Map.get(candidate, :category),
        created_at: Map.get(candidate, :created_at),
        note: "Backfilled from blog_post_published"
      }
  end

  defp feedback_exists?(feedback_key) do
    {:ok, result} =
      SQL.query(
        Repo,
        """
        SELECT 1
        FROM agent.event_lake
        WHERE team = 'blog'
          AND event_type = 'blog_feedback_created'
          AND metadata->>'feedback_key' = $1
        LIMIT 1
        """,
        [feedback_key]
      )

    result.num_rows > 0
  end

  defp insert_feedback_event!(event) do
    attrs = %{
      event_type: "blog_feedback_created",
      team: "blog",
      bot_name: "feedback_backfill",
      severity: "info",
      title: "[blog-phase3-backfill] #{event.feedback_key}",
      message: "feedback_ready #{event.feedback_key}",
      tags: ["phase3", "blog", "feedback", "backfill"],
      metadata: %{
        feedback_key: event.feedback_key,
        status: "prepared",
        note: event.note,
        post_type: event.post_type,
        writer: event.writer,
        title: event.title,
        post_id: event.post_id,
        category: event.category,
        backfilled: true
      },
      created_at: event.created_at,
      updated_at: event.created_at
    }

    %EventLake{}
    |> EventLake.changeset(attrs)
    |> Repo.insert!()
  end

  defp parse_int(nil), do: nil
  defp parse_int(value) when is_integer(value), do: value
  defp parse_int(value) when is_binary(value) do
    case Integer.parse(value) do
      {parsed, _} -> parsed
      :error -> nil
    end
  end
  defp parse_int(_), do: nil
end
