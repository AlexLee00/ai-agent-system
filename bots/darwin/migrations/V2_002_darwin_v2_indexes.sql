-- Darwin V2 확장 및 추가 인덱스
-- 생성일: 2026-04-18
-- 목적: pgvector 확장 활성화 (미설치 환경 대비)

-- pgvector 확장 활성화 (이미 설치된 경우 무시)
CREATE EXTENSION IF NOT EXISTS vector;
