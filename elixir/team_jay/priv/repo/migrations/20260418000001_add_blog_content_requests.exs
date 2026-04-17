defmodule TeamJay.Repo.Migrations.AddBlogContentRequests do
  use Ecto.Migration

  def up do
    execute "CREATE SCHEMA IF NOT EXISTS blog"

    execute """
    CREATE TABLE IF NOT EXISTS blog.content_requests (
      id                 BIGSERIAL PRIMARY KEY,
      source_team        VARCHAR(32)  NOT NULL,
      source_event       VARCHAR(64)  NOT NULL,
      regime             VARCHAR(32),
      mood               VARCHAR(64),
      angle_hint         VARCHAR(128) NOT NULL,
      keyword_hints      TEXT[]       NOT NULL DEFAULT '{}',
      urgency            VARCHAR(16)  NOT NULL DEFAULT 'normal'
                         CHECK (urgency IN ('urgent','normal','low')),
      metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,
      status             VARCHAR(16)  NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','fulfilled','expired','skipped','failed')),
      requested_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      expires_at         TIMESTAMPTZ  NOT NULL,
      fulfilled_at       TIMESTAMPTZ,
      fulfilled_post_id  BIGINT,
      fulfilled_category VARCHAR(64),
      fulfilled_topic    TEXT,
      skip_reason        TEXT,
      failure_detail     TEXT,
      retry_count        SMALLINT     NOT NULL DEFAULT 0
    )
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_content_requests_status_urgency
      ON blog.content_requests (status, urgency DESC, requested_at ASC)
      WHERE status = 'pending'
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_content_requests_source
      ON blog.content_requests (source_team, requested_at DESC)
    """
  end

  def down do
    execute "DROP INDEX IF EXISTS blog.idx_content_requests_source"
    execute "DROP INDEX IF EXISTS blog.idx_content_requests_status_urgency"
    execute "DROP TABLE IF EXISTS blog.content_requests"
  end
end
