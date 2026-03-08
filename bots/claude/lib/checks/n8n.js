'use strict';
/**
 * checks/n8n.js — n8n 워크플로우 서버 헬스체크
 */

const http = require('http');

const N8N_PORT = 5678;
const N8N_HOST = 'localhost';
const TIMEOUT_MS = 5000;

/**
 * n8n /healthz 응답 확인
 * @returns {Promise<{ status, label, detail }>}
 */
function checkN8nHealth() {
  return new Promise(resolve => {
    const start = Date.now();
    const req = http.request(
      { hostname: N8N_HOST, port: N8N_PORT, path: '/healthz', method: 'GET', timeout: TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          const ms = Date.now() - start;
          try {
            const json = JSON.parse(body);
            if (json.status === 'ok' && res.statusCode === 200) {
              resolve({ status: 'ok', label: 'n8n 워크플로우 서버', detail: `응답 ${ms}ms (HTTP 200)` });
            } else {
              resolve({ status: 'warn', label: 'n8n 워크플로우 서버', detail: `비정상 응답: ${body.slice(0, 80)}` });
            }
          } catch {
            resolve({ status: 'warn', label: 'n8n 워크플로우 서버', detail: `JSON 파싱 실패 (HTTP ${res.statusCode})` });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'warn', label: 'n8n 워크플로우 서버', detail: `응답 없음 (${TIMEOUT_MS}ms 타임아웃)` });
    });
    req.on('error', e => {
      const detail = e.code === 'ECONNREFUSED'
        ? '서버 미실행 (포트 5678 연결 거부)'
        : e.message.slice(0, 80);
      resolve({ status: 'warn', label: 'n8n 워크플로우 서버', detail });
    });
    req.end();
  });
}

/**
 * 덱스터 체크 인터페이스
 */
async function run() {
  const result = await checkN8nHealth();
  return {
    name: 'n8n 워크플로우',
    status: result.status,
    items: [result],
  };
}

module.exports = { run };
