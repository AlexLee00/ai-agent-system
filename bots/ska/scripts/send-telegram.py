"""
ska-008: 텔레그램 전송 헬퍼
stdin에서 메시지를 읽어 텔레그램 봇으로 전송

사용: python send-telegram.py < message.txt
"""
import sys
import json
import os
import urllib.request
import urllib.parse

SECRETS_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', '..', 'reservation', 'secrets.json')
)
HUB_SECRETS_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', '..', 'hub', 'secrets-store.json')
)


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    msg = sys.stdin.read().strip()
    if not msg:
        print('[TELEGRAM] ⚠️ 메시지 없음 — 전송 스킵')
        return

    secrets = load_json(SECRETS_PATH)
    hub_secrets = load_json(HUB_SECRETS_PATH)
    if not secrets and not hub_secrets:
        print('[TELEGRAM] ⚠️ secrets 로드 실패')
        sys.exit(1)

    hub_telegram = hub_secrets.get('telegram', {})
    token = hub_telegram.get('bot_token') or secrets.get('telegram_bot_token', '')
    # 그룹 ID 우선, 폴백: 개인 채팅 ID
    chat_id = hub_telegram.get('group_id') or secrets.get('telegram_group_id') or secrets.get('telegram_chat_id', '')
    # Class-topic 우선. legacy 스카 토픽은 class topic 설정이 없을 때만 fallback.
    hub_topics = hub_telegram.get('topic_ids', {}) or {}
    topic_ids = secrets.get('telegram_topic_ids', {}) or {}
    thread_id = (
        hub_topics.get('ops_work')
        or hub_topics.get('general')
        or topic_ids.get('ops_work')
        or topic_ids.get('general')
        or topic_ids.get('ska')
    )

    if not token or not chat_id:
        print('[TELEGRAM] ⚠️ 토큰/채팅ID 없음')
        sys.exit(1)

    payload = {'chat_id': str(chat_id), 'text': msg}
    if thread_id:
        payload['message_thread_id'] = int(thread_id)

    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/sendMessage',
        data=data,
        headers={'Content-Type': 'application/json'},
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get('ok'):
                print('[TELEGRAM] ✅ 전송 완료')
            else:
                print(f'[TELEGRAM] ⚠️ 전송 실패: {result}')
    except Exception as e:
        print(f'[TELEGRAM] ⚠️ 전송 오류: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
