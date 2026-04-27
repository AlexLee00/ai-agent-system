// @ts-nocheck
'use strict';

/**
 * scripts/setup-telegram-forum.js — Forum Topic 일괄 생성 (1회만 실행)
 *
 * 사전 조건:
 *   1. 텔레그램 그룹이 Forum(토론)으로 활성화되어 있어야 함
 *      → 그룹 설정 → Topics → Enable
 *   2. 봇이 그룹의 관리자여야 함 (Topic 생성 권한)
 *   3. bots/reservation/secrets.json에 telegram_bot_token, telegram_chat_id 존재
 *
 * 실행: node scripts/setup-telegram-forum.js
 * 결과: secrets.json에 telegram_topic_ids 저장
 *
 * ⚠️ 이미 telegram_topic_ids가 있으면 실행 중단 (기존 설정 보호).
 *    덮어쓰려면 secrets.json에서 telegram_topic_ids 항목 삭제 후 재실행.
 */

const fs   = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(__dirname, '../bots/reservation/secrets.json');

// ── Forum Topic 정의 ──────────────────────────────────────────────────
const CLASS_TOPIC_MODE = String(process.env.HUB_ALARM_USE_CLASS_TOPICS || 'true').trim().toLowerCase() !== 'false';
const ALLOW_LEGACY_TEAM_TOPICS = ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.ALLOW_LEGACY_TEAM_TOPICS || '').trim().toLowerCase());

const CLASS_TOPICS = [
  { key: 'ops_work',             name: '실무 알림',   icon_color: 0x6FB9F0 },
  { key: 'ops_reports',          name: '레포트 알림', icon_color: 0xFFD67E },
  { key: 'ops_error_resolution', name: '오류 해결',   icon_color: 0xCB86DB },
  { key: 'ops_emergency',        name: '긴급 알림',   icon_color: 0xFB6F5F },
];

const LEGACY_TEAM_TOPICS = [
  { key: 'general',    name: '📌 일반',      icon_color: 0x6FB9F0 },
  { key: 'ska',        name: '🏢 스카',      icon_color: 0xFFD67E },
  { key: 'luna',       name: '💰 루나',      icon_color: 0xCB86DB },
  { key: 'claude_lead',name: '🔧 클로드',    icon_color: 0x8EEE98 },
  { key: 'meeting',    name: '📊 팀장 회의록', icon_color: 0xFF93B2 },
  { key: 'emergency',  name: '🚨 긴급',      icon_color: 0xFB6F5F },
];

const TOPICS = CLASS_TOPIC_MODE
  ? CLASS_TOPICS
  : ALLOW_LEGACY_TEAM_TOPICS
    ? LEGACY_TEAM_TOPICS
    : [];

// ── 헬퍼 ─────────────────────────────────────────────────────────────

function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  } catch (e) {
    console.error(`❌ secrets.json 읽기 실패: ${e.message}`);
    process.exit(1);
  }
}

function saveSecrets(secrets) {
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2) + '\n', 'utf-8');
}

/**
 * Telegram Bot API: createForumTopic
 * @returns {number} message_thread_id
 */
async function createTopic(token, chatId, name, iconColor) {
  const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      name:       name,
      icon_color: iconColor,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || '알 수 없는 오류');
  return data.result.message_thread_id;
}

// ── 메인 ─────────────────────────────────────────────────────────────

async function main() {
  if (!CLASS_TOPIC_MODE && !ALLOW_LEGACY_TEAM_TOPICS) {
    console.error('❌ legacy 팀별 토픽 생성은 차단되었습니다. 필요 시 ALLOW_LEGACY_TEAM_TOPICS=1을 명시하세요.');
    process.exit(1);
  }

  const secrets = loadSecrets();
  const token   = secrets.telegram_bot_token;
  const chatId  = secrets.telegram_group_id || secrets.telegram_chat_id;  // 그룹 우선

  if (!token || !chatId) {
    console.error('❌ secrets.json에 telegram_bot_token / telegram_chat_id가 없습니다.');
    process.exit(1);
  }

  // 기존 topic_ids 존재 시 보호
  if (secrets.telegram_topic_ids && Object.keys(secrets.telegram_topic_ids).length > 0) {
    console.warn('⚠️  이미 telegram_topic_ids가 설정되어 있습니다.');
    console.warn('   덮어쓰려면 secrets.json에서 telegram_topic_ids 항목을 삭제 후 재실행하세요.\n');
    console.log('현재 설정:');
    for (const [key, id] of Object.entries(secrets.telegram_topic_ids)) {
      const topic = TOPICS.find(t => t.key === key);
      console.log(`  ${topic?.name ?? key}: ${id}`);
    }
    process.exit(0);
  }

  console.log('📋 Forum Topic 생성 시작...');
  console.log(`   봇 토큰: ...${token.slice(-8)}`);
  console.log(`   채팅 ID: ${chatId}\n`);

  const topicIds = {};
  for (const topic of TOPICS) {
    try {
      const threadId = await createTopic(token, chatId, topic.name, topic.icon_color);
      topicIds[topic.key] = threadId;
      console.log(`✅ ${topic.name} → thread_id: ${threadId}`);
      await new Promise(r => setTimeout(r, 600));  // Rate limit 방지
    } catch (e) {
      console.error(`❌ ${topic.name} 실패: ${e.message}`);
    }
  }

  if (Object.keys(topicIds).length === 0) {
    console.error('\n❌ 모든 Topic 생성에 실패했습니다. 봇 권한을 확인하세요.');
    process.exit(1);
  }

  // secrets.json에 저장
  secrets.telegram_topic_ids = topicIds;
  saveSecrets(secrets);

  console.log(`\n✅ ${Object.keys(topicIds).length}/${TOPICS.length}개 Topic 생성 완료`);
  console.log('   secrets.json에 telegram_topic_ids 저장됨');
  console.log('\n다음 단계:');
  console.log('  1. 텔레그램 그룹에서 Topic이 생성됐는지 확인');
  console.log('  2. 스카팀 봇 재시작으로 Forum 라우팅 적용');
  console.log('  3. 각 팀 봇 재시작');
}

main().catch(e => {
  console.error('❌ 스크립트 오류:', e.message);
  process.exit(1);
});
