# CODEX_CHRONOS_PHASE_A_OPS — Ollama 서버 설정 + 모델 다운로드

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥 스튜디오 (OPS)** — 인프라 설정, Git 커밋 없음
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 배경

Chronos(백테스팅) 구축을 위해 OPS에 로컬 LLM 인프라 필요.
API LLM 비용 비현실적 (1회 백테스트 ~$35) → 로컬 LLM(Ollama) 필수.

### 현재 상태

```
Ollama 바이너리: ✅ 설치됨 (v0.19.0, /opt/homebrew/bin/ollama)
Ollama 서버: ❌ 미실행
모델: ❌ 미다운로드
하드웨어: Mac Studio M4 Max 14코어 36GB RAM
디스크: 291GB 여유
```

---

## 작업 1: Ollama 서버 시작 + 동작 확인

```bash
# 서버 시작 (백그라운드)
ollama serve &

# 서버 동작 확인
curl -s http://localhost:11434/api/version
# 기대: { "version": "0.19.0" }
```

---

## 작업 2: 모델 다운로드

M4 Max 36GB 기준 권장 모델:

```bash
# Layer 2: 감성/뉴스 시뮬레이션 (가벼운 모델, 빠른 추론)
ollama pull qwen2.5:7b
# 약 4.7GB, M4 Max에서 ~40 tok/s

# Layer 3: 종합 판단 시뮬레이션 (무거운 모델, 정밀 추론)
ollama pull deepseek-r1:32b
# 약 19GB, M4 Max에서 ~15 tok/s
```

---

## 작업 3: 모델 동작 확인

```bash
# qwen2.5:7b 테스트
ollama run qwen2.5:7b "BTC 현재 RSI가 72일 때 단기 전망을 한 문장으로."
# 기대: 한국어 or 영어 답변 (동작 확인)

# deepseek-r1:32b 테스트
ollama run deepseek-r1:32b "당신은 트레이딩 팀장. BUY/SELL/HOLD 중 하나만."
# 기대: BUY/SELL/HOLD 중 하나
```

---

## 작업 4: launchd로 자동 실행 등록

OPS 재부팅 시 자동 시작:

새 파일: `~/Library/LaunchAgents/ai.ollama.serve.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ollama.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ollama</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ollama.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ollama.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLAMA_HOST</key>
    <string>0.0.0.0:11434</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/ai.ollama.serve.plist
launchctl list | grep ollama
# 기대: PID  0  ai.ollama.serve
```

### 참고: DEV(맥북 에어)에서 접근

OLLAMA_HOST=0.0.0.0 설정으로 Tailscale 경유 접근 가능:
```
OPS: localhost:11434 (로컬)
DEV: http://REDACTED_TAILSCALE_IP:11434 (Tailscale 경유, Hub 패턴과 동일)
```

Hub와 동일한 구조:
```
Hub:    OPS localhost:7788  → DEV REDACTED_TAILSCALE_IP:7788
Ollama: OPS localhost:11434 → DEV REDACTED_TAILSCALE_IP:11434
```

---

## 완료 기준

```bash
# 1. Ollama 서버 동작
curl -s http://localhost:11434/api/version
# 기대: { "version": "..." }

# 2. 모델 목록
ollama list
# 기대: qwen2.5:7b, deepseek-r1:32b 2개

# 3. launchd 등록
launchctl list | grep ollama
# 기대: PID  0  ai.ollama.serve

# 4. 재부팅 시뮬레이션 (선택)
launchctl kickstart -kp gui/$(id -u)/ai.ollama.serve
sleep 3
curl -s http://localhost:11434/api/version
# 기대: 정상 응답
```

⚠️ 이 작업은 Git 커밋 없음 — 시스템 인프라 설정만.
완료 후 운영 채팅(메티)에게 결과를 보고해줘.
