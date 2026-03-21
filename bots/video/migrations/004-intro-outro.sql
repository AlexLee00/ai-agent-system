ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS intro_mode TEXT DEFAULT 'none';
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS intro_prompt TEXT;
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS intro_duration_sec INTEGER DEFAULT 3;
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS outro_mode TEXT DEFAULT 'none';
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS outro_prompt TEXT;
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS outro_duration_sec INTEGER DEFAULT 5;
