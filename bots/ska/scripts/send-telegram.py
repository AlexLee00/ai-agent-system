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


def main():
    msg = sys.stdin.read().strip()
    if not msg:
        print('[TELEGRAM] ⚠️ 메시지 없음 — 전송 스킵')
        return

    try:
        secrets = json.load(open(SECRETS_PATH))
    except Exception as e:
        print(f'[TELEGRAM] ⚠️ secrets 로드 실패: {e}')
        sys.exit(1)

    token = secrets.get('telegram_bot_token', '')
    # 그룹 ID 우선, 폴백: 개인 채팅 ID
    chat_id = secrets.get('telegram_group_id') or secrets.get('telegram_chat_id', '')
    # 스카팀 Forum Topic thread_id (설정 없으면 일반 발송)
    topic_ids = secrets.get('telegram_topic_ids', {})
    thread_id = topic_ids.get('ska')

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
