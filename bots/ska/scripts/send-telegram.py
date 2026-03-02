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
    chat_id = secrets.get('telegram_chat_id', '')

    if not token or not chat_id:
        print('[TELEGRAM] ⚠️ 토큰/채팅ID 없음')
        sys.exit(1)

    data = urllib.parse.urlencode({'chat_id': str(chat_id), 'text': msg}).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/sendMessage',
        data=data
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
