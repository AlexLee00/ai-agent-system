-- bots/blog/migrations/021-omnichannel-marketing-os.sql
-- Omnichannel Marketing OS: campaign / variant / queue / quality / metrics

-- 마케팅 캠페인 원본 (채널 독립)
CREATE TABLE IF NOT EXISTS blog.marketing_campaigns (
  campaign_id     TEXT PRIMARY KEY,          -- ulid or uuid
  brand_axis      TEXT NOT NULL DEFAULT 'cafe_library',
    -- 'cafe_library' | 'seungho_dad' | 'mixed'
  objective       TEXT NOT NULL DEFAULT 'awareness',
    -- 'awareness' | 'engagement' | 'conversion' | 'retention' | 'brand_trust'
  source_signal   JSONB,
  strategy_version TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
    -- 'active' | 'paused' | 'completed' | 'archived'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_brand
  ON blog.marketing_campaigns(brand_axis, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_objective
  ON blog.marketing_campaigns(objective, created_at DESC);

-- 플랫폼별 variant (campaign의 채널 표현)
CREATE TABLE IF NOT EXISTS blog.marketing_platform_variants (
  variant_id      TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES blog.marketing_campaigns(campaign_id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
    -- 'naver_blog' | 'instagram_feed' | 'instagram_reel' | 'instagram_story' | 'facebook_page'
  source_mode     TEXT NOT NULL DEFAULT 'strategy_native',
    -- 'strategy_native' | 'naver_post' | 'manual_seed' | 'recovery'
  title           TEXT,
  body            TEXT,
  caption         TEXT,
  hashtags        TEXT[],
  cta             TEXT,
  asset_refs      JSONB,       -- { reelPath, coverPath, qaSheetPath, publicUrls }
  tracking_url    TEXT,
  quality_score   NUMERIC(5,2),
  quality_status  TEXT DEFAULT 'pending',
    -- 'pending' | 'passed' | 'blocked' | 'regenerating'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_variants_campaign
  ON blog.marketing_platform_variants(campaign_id, platform);

CREATE INDEX IF NOT EXISTS idx_variants_platform_mode
  ON blog.marketing_platform_variants(platform, source_mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_variants_quality
  ON blog.marketing_platform_variants(quality_status, platform);

-- 발행 큐 (variant 단위 실행 대상)
CREATE TABLE IF NOT EXISTS blog.marketing_publish_queue (
  queue_id          TEXT PRIMARY KEY,
  variant_id        TEXT NOT NULL REFERENCES blog.marketing_platform_variants(variant_id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
    -- 'queued' | 'preparing' | 'publishing' | 'published' | 'failed' | 'blocked' | 'skipped'
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  failure_kind      TEXT,
    -- 'auth' | 'asset_prepare' | 'media_url' | 'container_processing' | 'publish' | 'rate_limit' | 'quality_gate' | 'unknown'
  idempotency_key   TEXT NOT NULL,
  dry_run           BOOLEAN NOT NULL DEFAULT FALSE,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_idempotency
  ON blog.marketing_publish_queue(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_queue_platform_status
  ON blog.marketing_publish_queue(platform, status, scheduled_at ASC);

CREATE INDEX IF NOT EXISTS idx_queue_scheduled
  ON blog.marketing_publish_queue(scheduled_at ASC)
  WHERE status IN ('queued', 'preparing');

-- 크리에이티브 품질 게이트 점수
CREATE TABLE IF NOT EXISTS blog.marketing_creative_quality (
  variant_id        TEXT PRIMARY KEY REFERENCES blog.marketing_platform_variants(variant_id) ON DELETE CASCADE,
  score_total       NUMERIC(5,2) NOT NULL DEFAULT 0,
  brand_score       NUMERIC(5,2) NOT NULL DEFAULT 0,
  hook_score        NUMERIC(5,2) NOT NULL DEFAULT 0,
  cta_score         NUMERIC(5,2) NOT NULL DEFAULT 0,
  visual_score      NUMERIC(5,2) NOT NULL DEFAULT 0,
  policy_score      NUMERIC(5,2) NOT NULL DEFAULT 0,
  api_readiness_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  reasons           JSONB,        -- { passed: [...], blocked: [...], recoverable: [...] }
  gate_result       TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'passed' | 'blocked' | 'recoverable'
  evaluated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creative_quality_gate
  ON blog.marketing_creative_quality(gate_result, evaluated_at DESC);

-- 채널 성과 지표 (Meta Insights 수집 대상)
CREATE TABLE IF NOT EXISTS blog.marketing_channel_metrics (
  id              BIGSERIAL PRIMARY KEY,
  variant_id      TEXT REFERENCES blog.marketing_platform_variants(variant_id) ON DELETE SET NULL,
  platform        TEXT NOT NULL,
  metric_date     DATE NOT NULL,
  reach           INTEGER,
  impressions     INTEGER,
  likes           INTEGER,
  comments        INTEGER,
  saves           INTEGER,
  shares          INTEGER,
  clicks          INTEGER,
  profile_actions INTEGER,
  follows         INTEGER,
  raw_payload     JSONB,
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_metrics_uq
  ON blog.marketing_channel_metrics(variant_id, platform, metric_date)
  WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_metrics_platform_date
  ON blog.marketing_channel_metrics(platform, metric_date DESC);
