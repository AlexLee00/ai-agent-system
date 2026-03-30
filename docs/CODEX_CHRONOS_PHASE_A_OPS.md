# CODEX_CHRONOS_PHASE_A_OPS — MLX 로컬 LLM 인프라 설정

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥 스튜디오 (OPS)** — 인프라 설정, Git 커밋 없음
> 작성일: 2026-03-30 (v2 — Ollama→MLX 전환)
> 작성자: 메티 (전략+설계)

---

## 배경

Chronos(백테스팅) 구축을 위해 OPS에 로컬 LLM 인프라 필요.
API LLM 비용 비현실적 (1회 백테스트 ~$35) → 로컬 LLM 필수.

### MLX 선택 이유 (2026 리서치 기반)

```
arXiv 논문(2511.05502) + 커뮤니티 벤치마크:
  MLX:    ~230 tok/s (7B) — Apple Silicon 네이티브, UMA 직접 활용
  Ollama: ~150 tok/s (7B) — llama.cpp 경유 (간접)
  → MLX가 20~50% 빠름

우리 환경: Mac Studio M4 Max 36GB → MLX 최적
배치 반복 호출 (수백~수천 번) → 속도 차이가 총 소요시간에 직결
```

### 현재 상태

```
Ollama: 바이너리 설치됨 + 설치 진행 중 (제거 필요)
MLX: 미설치
Python: 3.12 (Homebrew)
하드웨어: Mac Studio M4 Max 14코어 36GB
디스크: ~291GB 여유
```

---

## 작업 1: Ollama 정리 (제거)

MLX로 전환하므로 Ollama 관련 리소스를 정리합니다.

```bash
# 1-1. Ollama 서버 중지 (실행 중이면)
pkill -f "ollama serve" 2>/dev/null
launchctl unload ~/Library/LaunchAgents/ai.ollama.serve.plist 2>/dev/null

# 1-2. launchd plist 제거 (있으면)
rm -f ~/Library/LaunchAgents/ai.ollama.serve.plist

# 1-3. Ollama Homebrew 제거
brew uninstall ollama 2>/dev/null

# 1-4. Ollama 모델/데이터 제거
rm -rf ~/.ollama

# 1-5. 확인
which ollama 2>/dev/null && echo "⚠️ 아직 남아있음" || echo "✅ Ollama 제거 완료"
ls ~/.ollama 2>/dev/null && echo "⚠️ 데이터 남아있음" || echo "✅ 데이터 제거 완료"
```

---

## 작업 2: MLX + mlx-lm 설치

```bash
# 2-1. Python 가상환경 생성 (시스템 Python 오염 방지)
python3 -m venv ~/mlx-env
source ~/mlx-env/bin/activate

# 2-2. mlx-lm 설치 (mlx-core 자동 포함)
pip install mlx-lm

# 2-3. mlx-openai-server 설치 (OpenAI 호환 API 서버)
pip install mlx-openai-server

# 2-4. 설치 확인
python3 -c "import mlx.core; print('MLX version:', mlx.core.__version__)"
python3 -c "import mlx_lm; print('mlx-lm OK')"
mlx-openai-server --help 2>&1 | head -3
```

---

## 작업 3: 모델 다운로드

HuggingFace mlx-community에서 사전 변환된 모델 다운로드:

```bash
source ~/mlx-env/bin/activate

# Layer 2: 감성/뉴스 시뮬레이션 (가벼운 모델, 빠른 추론)
# Qwen2.5 7B 4bit — ~4GB, M4 Max에서 ~80-100 tok/s
python3 -m mlx_lm.generate \
  --model mlx-community/Qwen2.5-7B-Instruct-4bit \
  --prompt "Say hello" --max-tokens 10
# 첫 실행 시 자동 다운로드 (~4GB) → ~/.cache/huggingface/

# Layer 3: 종합 판단 시뮬레이션 (무거운 모델, 정밀 추론)
# DeepSeek-R1-Distill-Qwen-32B 4bit — ~18GB, M4 Max에서 ~20-25 tok/s
python3 -m mlx_lm.generate \
  --model mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit \
  --prompt "Say hello" --max-tokens 10
# 첫 실행 시 자동 다운로드 (~18GB)
```

### 모델 동작 확인

```bash
# Qwen 7B 테스트
python3 -m mlx_lm.generate \
  --model mlx-community/Qwen2.5-7B-Instruct-4bit \
  --prompt "BTC RSI가 72일 때 단기 전망을 한 문장으로." \
  --max-tokens 100
# 기대: 한국어/영어 응답 (동작 확인)

# DeepSeek 32B 테스트
python3 -m mlx_lm.generate \
  --model mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit \
  --prompt "당신은 트레이딩 팀장. BUY/SELL/HOLD 중 하나만." \
  --max-tokens 50
# 기대: BUY/SELL/HOLD 중 하나
```

---

## 작업 4: MLX 서버 구성 + launchd 등록

### 4-1. 서버 설정 파일

새 파일: `~/mlx-server-config.yaml`

```yaml
server:
  host: "0.0.0.0"
  port: 11434
  log_level: INFO

models:
  - model_path: mlx-community/Qwen2.5-7B-Instruct-4bit
    model_type: lm
    served_model_name: qwen2.5-7b
    context_length: 4096

  - model_path: mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit
    model_type: lm
    served_model_name: deepseek-r1-32b
    context_length: 4096
    on_demand: true
    on_demand_idle_timeout: 300
```

참고:
- host 0.0.0.0 → DEV(맥북 에어)에서 Tailscale 경유 접근 허용
- port 11434 → 기존 Ollama 포트 재사용 (코드 변경 최소화)
- deepseek on_demand: true → 사용 시에만 메모리 로드 (36GB 보호)
- on_demand_idle_timeout: 300초 미사용 시 자동 언로드

### 4-2. 수동 서버 시작 (테스트)

```bash
source ~/mlx-env/bin/activate
mlx-openai-server launch --config ~/mlx-server-config.yaml &
sleep 5

# 동작 확인
curl -s http://localhost:11434/v1/models | python3 -m json.tool
# 기대: qwen2.5-7b, deepseek-r1-32b 모델 목록

# 추론 테스트 (OpenAI 호환 API)
curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-7b",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 20
  }' | python3 -m json.tool
# 기대: choices[0].message.content에 응답
```

### 4-3. launchd 자동 실행 등록

새 파일: `~/Library/LaunchAgents/ai.mlx.server.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.mlx.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/alexlee/mlx-env/bin/mlx-openai-server</string>
    <string>launch</string>
    <string>--config</string>
    <string>/Users/alexlee/mlx-server-config.yaml</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/mlx-server.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/mlx-server.err.log</string>
  <key>WorkingDirectory</key>
  <string>/Users/alexlee</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/ai.mlx.server.plist
sleep 5
launchctl list | grep mlx
# 기대: PID  0  ai.mlx.server
```

---

## DEV(맥북 에어)에서 접근

0.0.0.0 바인딩으로 Tailscale 경유 접근 가능:

```
OPS: http://localhost:11434     (로컬)
DEV: http://REDACTED_TAILSCALE_IP:11434 (Tailscale 경유)

Hub 패턴과 동일:
  Hub:    OPS :7788  → DEV REDACTED_TAILSCALE_IP:7788
  MLX:    OPS :11434 → DEV REDACTED_TAILSCALE_IP:11434
  단, MLX는 Hub 경유 안 함 (장시간 응답, 직접 접근)
```

---

## 완료 기준

```bash
# 1. Ollama 제거 확인
which ollama 2>/dev/null && echo "❌" || echo "✅ Ollama 제거"
ls ~/.ollama 2>/dev/null && echo "❌" || echo "✅ 데이터 제거"

# 2. MLX 설치 확인
source ~/mlx-env/bin/activate
python3 -c "import mlx.core; print('✅ MLX:', mlx.core.__version__)"

# 3. 모델 확인
curl -s http://localhost:11434/v1/models | python3 -m json.tool
# 기대: qwen2.5-7b + deepseek-r1-32b

# 4. 추론 테스트
curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-7b","messages":[{"role":"user","content":"1+1=?"}],"max_tokens":10}'
# 기대: 정상 응답

# 5. launchd 등록
launchctl list | grep mlx
# 기대: PID  0  ai.mlx.server

# 6. DEV에서 접근 테스트 (맥북 에어에서)
curl -s http://REDACTED_TAILSCALE_IP:11434/v1/models
# 기대: 모델 목록 (Tailscale 경유)
```

⚠️ 이 작업은 Git 커밋 없음 — 시스템 인프라 설정만.
완료 후 운영 채팅(메티)에게 결과를 보고해줘.
