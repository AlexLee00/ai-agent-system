// @ts-nocheck
'use strict';

/**
 * bots/blog/lib/pipeline-store.js
 *
 * 블로팀 파이프라인 세션 저장소 래퍼.
 * 실제 구현은 core의 blog-rag-store를 사용하지만,
 * 블로팀 코드에서는 "RAG"보다 "세션별 노드 결과 저장소" 역할이 더 중요하다.
 *
 * 역할:
 * - session_id 기반 노드 결과 저장/조회
 * - n8n/node-server/direct fallback 사이의 결과 연결
 * - 부분 재실행/결과 회수 지원
 */

module.exports = require('../../../packages/core/lib/blog-rag-store');
