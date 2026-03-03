#!/usr/bin/env node
'use strict';

/**
 * scripts/team-status.js — 클로드팀 상태 콘솔 출력
 *
 * 사용법: node scripts/team-status.js
 * 출력: 에이전트 상태, 미확인 메시지, 최근 체크 이력, 기술 소화 이력
 */

const teamBus = require('../lib/team-bus');

function ago(isoStr) {
  if (!isoStr) return '-';
  const diff = Math.floor((Date.now() - new Date(isoStr + 'Z').getTime()) / 1000);
  if (diff < 60)   return `${diff}초 전`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

function statusEmoji(status) {
  return status === 'idle' ? '💤' : status === 'running' ? '🔄' : '❌';
}

function main() {
  console.log('\n══════════════════════════════════════');
  console.log('  클로드팀 상태 대시보드');
  console.log('══════════════════════════════════════\n');

  // 1. 에이전트 상태
  console.log('▶ 에이전트 상태');
  try {
    const statuses = teamBus.getAllStatuses();
    if (statuses.length === 0) {
      console.log('  (데이터 없음)');
    }
    for (const s of statuses) {
      const emoji = statusEmoji(s.status);
      console.log(`  ${emoji} ${s.agent.padEnd(8)} [${s.status.padEnd(7)}]  마지막 갱신: ${ago(s.updated_at)}`);
      if (s.current_task)    console.log(`            작업: ${s.current_task}`);
      if (s.last_success_at) console.log(`            성공: ${ago(s.last_success_at)}`);
      if (s.last_error)      console.log(`            오류: ${s.last_error.slice(0, 80)}`);
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  // 2. 미확인 메시지
  console.log('\n▶ 미확인 메시지');
  try {
    const msgs = teamBus.getMessages();
    if (msgs.length === 0) {
      console.log('  (없음)');
    } else {
      for (const m of msgs.slice(0, 10)) {
        console.log(`  [${m.type.padEnd(5)}] ${m.from_agent} → ${m.to_agent}: ${m.subject || m.body?.slice(0, 60) || '-'} (${ago(m.created_at)})`);
      }
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  // 3. 최근 체크 이력 (덱스터)
  console.log('\n▶ 최근 체크 이력 (덱스터)');
  try {
    const checks = teamBus.getRecentChecks(null, 15);
    if (checks.length === 0) {
      console.log('  (없음)');
    } else {
      const grouped = {};
      for (const c of checks) {
        if (!grouped[c.check_name]) grouped[c.check_name] = [];
        grouped[c.check_name].push(c);
      }
      for (const [name, list] of Object.entries(grouped)) {
        const last  = list[0];
        const emoji = last.status === 'ok' ? '✅' : last.status === 'warn' ? '⚠️' : '❌';
        console.log(`  ${emoji} ${name.padEnd(20)} 항목: ${last.item_count}개, 오류: ${last.error_count}개  (${ago(last.ran_at)})`);
      }
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  // 4. 최근 기술 소화 이력 (아처)
  console.log('\n▶ 최근 기술 소화 (아처)');
  try {
    const digests = teamBus.getRecentDigests(5);
    if (digests.length === 0) {
      console.log('  (없음)');
    } else {
      for (const d of digests) {
        const notified = d.notified ? '✉️' : '📬';
        console.log(`  ${notified} [${d.source}] ${d.title.slice(0, 60)} (${ago(d.created_at)})`);
      }
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  console.log('\n══════════════════════════════════════\n');
}

main();
