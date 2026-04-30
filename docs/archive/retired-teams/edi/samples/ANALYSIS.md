# 영상 샘플 ffprobe 분석 결과

> 분석일: 2026-03-20
> 대상: 5세트 (raw + narration + edited)
> 도구: ffprobe + ffmpeg loudnorm

---

## 1. 원본 영상 (raw/)

```
파일              해상도       fps    코덱    비트레이트   시간
───────────────  ──────────  ─────  ──────  ─────────  ────────
원본_DB생성       1920x1080   60fps  H.264   270kbps    73m36s
원본_동적데이터    1920x1080   60fps  H.264   342kbps    46m49s
원본_서버인증      1920x1080   60fps  H.264   268kbps    33m04s
원본_컴포넌트스테이트 1920x1080 60fps  H.264   276kbps    47m17s
원본_파라미터      1920x1080   60fps  H.264   267kbps    23m30s

공통: H.264, AAC 48000Hz stereo, ~270kbps (저비트레이트 스크린캡처)
```

## 2. 나레이션 (narration/)

```
파일                    코덱   샘플레이트  채널   비트레이트  시간
──────────────────────  ────  ─────────  ────  ─────────  ─────
나레이션_DB생성           AAC   44100Hz   mono   68kbps    8m24s
나레이션_동적데이터        AAC   44100Hz   mono   68kbps    7m59s
나레이션_서버인증          AAC   44100Hz   mono   68kbps    14m06s
나레이션_컴포넌트스테이트    AAC   44100Hz   mono   68kbps    8m00s
나레이션_파라미터          AAC   44100Hz   mono   68kbps    4m21s

공통: AAC 44100Hz mono 68kbps (일관된 녹음 설정)
```

## 3. 편집본 (edited/)

```
파일              해상도       fps    코덱    비트레이트   오디오          시간
───────────────  ──────────  ─────  ──────  ─────────  ────────────  ────────
편집_DB생성       2560x1440   60fps  H.264   3053kbps  AAC 44kHz 2ch  22m13s
편집_동적데이터    2542x1440   60fps  H.264   3659kbps  AAC 44kHz 2ch  11m31s
편집_서버인증      2560x1440   60fps  H.264   3007kbps  AAC 44kHz 2ch  34m17s
편집_컴포넌트스테이트 2542x1440 60fps  H.264   2749kbps  AAC 44kHz 2ch  13m27s
편집_파라미터      2542x1440   60fps  H.264   3425kbps  AAC 44kHz 2ch  6m50s
```

## 4. 오디오 LUFS 분석 (편집본)

```
파일              LUFS      True Peak   LRA
───────────────  ────────  ──────────  ─────
편집_DB생성       -14.72    0.76 dBTP   20.3
편집_동적데이터    -14.10    0.69 dBTP   17.6
편집_서버인증      -14.59    1.29 dBTP   19.1
편집_컴포넌트스테이트 -14.12   1.40 dBTP   20.6
편집_파라미터      -14.10    0.37 dBTP   17.6

평균 LUFS: -14.33 (YouTube 권장 -14 LUFS에 매우 근접)
★ True Peak이 0dBTP 초과 → 클리핑 발생 중 (정규화 필요)
```

## 5. 원본 vs 편집본 비교

```
세트              원본시간  나레이션  편집시간  컷팅률   원본→편집 해상도
───────────────  ────────  ───────  ────────  ──────  ─────────────
DB생성            73m36s   8m24s   22m13s    69.8%   1080p → 1440p
동적데이터         46m49s   7m59s   11m31s    75.4%   1080p → 1440p
서버인증           33m04s   14m06s  34m17s    -3.7%   1080p → 1440p
컴포넌트스테이트    47m17s   8m00s   13m27s    71.6%   1080p → 1440p
파라미터           23m30s   4m21s   6m50s     70.9%   1080p → 1440p

평균 컷팅률: 60.6% (서버인증 제외 시 72.0%)
★ 서버인증은 편집본이 더 긴 예외 (나레이션 14분이 추가됨)
```

---

## 6. 초기 분석 결과 (YouTube 공식 확인 전 — 참고용)

```
[입력 — 원본]
  해상도: 1920x1080
  FPS: 60
  코덱: H.264
  비트레이트: ~270kbps (저비트레이트 스크린캡처)
  오디오: AAC 48000Hz stereo

[입력 — 나레이션]
  코덱: AAC
  샘플레이트: 44100Hz
  채널: mono
  비트레이트: 68kbps

[출력 — 편집본 목표]
  해상도: 2560x1440 (표준 1440p, CapCut 2542 비표준은 피함)
  FPS: 60
  코덱: H.264
  비트레이트: ~3000kbps (범위: 2700~3600)
  오디오: AAC 44100Hz stereo
  오디오 비트레이트: ~128kbps
  LUFS 목표: -14.0 (YouTube 권장, 현재 -14.3 평균)
  True Peak 목표: -1.0 dBTP (현재 클리핑 방지)
  ⚠️ 위 값은 초기 분석 기준. YouTube 공식 권장 확인 후 섹션 8에서 최종 확정.
```

## 7. 초기 config 값 (⚠️ 섹션 8의 최종 확정값으로 대체됨)

```yaml
# ⚠️ 초기 분석값 — 최종 확정값은 섹션 8 참조
output:
  width: 2560
  height: 1440
  fps: 60
  codec: libx264
  video_bitrate: 3000k
  audio_codec: aac
  audio_bitrate: 128k
  audio_sample_rate: 44100

audio_normalize:
  target_lufs: -14.0
  true_peak: -1.0
  lra: 20.0

input_expected:
  raw_resolution: 1920x1080
  raw_fps: 60
  raw_audio_sample_rate: 48000
  narration_sample_rate: 44100
  narration_channels: 1
```


---

## 8. ★ YouTube 공식 권장 vs 파이프라인 최종 확정값

```
유튜브가 1440p 이상 영상에 VP9 코덱을 적용 (1080p는 AVC1/H.264)
→ 더백클래스가 1440p로 업로드하는 전략은 정확함 (VP9 강제 트리거)
→ VP9은 같은 비트레이트에서 AVC1보다 훨씬 선명
→ 유튜브 스트리밍: 1440p@60fps VP9 = 12Mbps vs 1080p@60fps AVC1 = 5.7Mbps

문제: 현재 업로드 비트레이트 ~3Mbps (권장 24Mbps의 12%)
→ 유튜브 재인코딩 전 원본 품질이 높을수록 최종 품질도 높아짐
→ 파이프라인에서 24Mbps로 렌더링하면 체감 품질 대폭 향상
```

### video-config.yaml 최종 확정값

```yaml
# YouTube 공식 권장 기반 확정 (2026-03-20)
# https://support.google.com/youtube/answer/1722171

output:
  width: 2560
  height: 1440
  fps: 60
  codec: libx264
  profile: high            # YouTube 권장: H.264 High Profile
  video_bitrate: 24M       # YouTube 권장: 1440p@60fps = 24 Mbps
  pixel_format: yuv420p    # YouTube 권장: 4:2:0
  movflags: +faststart     # YouTube 권장: moov atom at front
  color_space: bt709       # YouTube 권장: BT.709 SDR

audio:
  codec: aac               # YouTube 권장: AAC-LC
  bitrate: 384k            # YouTube 권장: Stereo = 384 kbps
  sample_rate: 48000       # YouTube 권장: 48kHz
  channels: 2              # Stereo

audio_normalize:
  target_lufs: -14.0       # YouTube 표준
  true_peak: -1.0          # 클리핑 방지 (현재 +1.4 → -1.0으로)
  lra: 20.0

input_expected:
  raw_resolution: 1920x1080
  raw_fps: 60
  raw_codec: h264
  raw_bitrate_range: 250-350kbps  # 저비트레이트 스크린캡처
  raw_audio_sample_rate: 48000
  narration_codec: aac
  narration_sample_rate: 44100
  narration_channels: 1           # mono
  narration_bitrate: 68kbps
```
