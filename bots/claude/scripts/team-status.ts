#!/usr/bin/env node
// @ts-nocheck
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
  const diff = Math.floor((Date.now() - new Date(`${isoStr}Z`).getTime()) / 1000);
  if (diff < 60) return `${diff}초 전`;
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

  console.log('▶ 에이전트 상태');
  try {
    const statuses = teamBus.getAllStatuses();
    if (statuses.length === 0) {
      console.log('  (데이터 없음)');
    }
    for (const status of statuses) {
      const emoji = statusEmoji(status.status);
      console.log(`  ${emoji} ${status.agent.padEnd(8)} [${status.status.padEnd(7)}]  마지막 갱신: ${ago(status.updated_at)}`);
      if (status.current_task) console.log(`            작업: ${status.current_task}`);
      if (status.last_success_at) console.log(`            성공: ${ago(status.last_success_at)}`);
      if (status.last_error) console.log(`            오류: ${status.last_error.slice(0, 80)}`);
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  console.log('\n▶ 미확인 메시지');
  try {
    const msgs = teamBus.getMessages();
    if (msgs.length === 0) {
      console.log('  (없음)');
    } else {
      for (const msg of msgs.slice(0, 10)) {
        console.log(`  [${msg.type.padEnd(5)}] ${msg.from_agent} → ${msg.to_agent}: ${msg.subject || msg.body?.slice(0, 60) || '-'} (${ago(msg.created_at)})`);
      }
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  console.log('\n▶ 최근 체크 이력 (덱스터)');
  try {
    const checks = teamBus.getRecentChecks(null, 15);
    if (checks.length === 0) {
      console.log('  (없음)');
    } else {
      const grouped = {};
      for (const check of checks) {
        if (!grouped[check.check_name]) grouped[check.check_name] = [];
        grouped[check.check_name].push(check);
      }
      for (const [name, list] of Object.entries(grouped)) {
        const last = list[0];
        const emoji = last.status === 'ok' ? '✅' : last.status === 'warn' ? '⚠️' : '❌';
        console.log(`  ${emoji} ${name.padEnd(20)} 항목: ${last.item_count}개, 오류: ${last.error_count}개  (${ago(last.ran_at)})`);
      }
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  console.log('\n▶ 최근 기술 소화 (아처)');
  try {
    const digests = teamBus.getRecentDigests(5);
    if (digests.length === 0) {
      console.log('  (없음)');
    } else {
      for (const digest of digests) {
        const notified = digest.notified ? '✉️' : '📬';
        console.log(`  ${notified} [${digest.source}] ${digest.title.slice(0, 60)} (${ago(digest.created_at)})`);
      }
    }
  } catch (e) {
    console.log(`  오류: ${e.message}`);
  }

  console.log('\n══════════════════════════════════════\n');
}

main();
