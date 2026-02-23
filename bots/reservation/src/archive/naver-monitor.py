#!/usr/bin/env python3
"""
네이버 스마트플레이스 예약현황 모니터링 스크립트
5분 주기로 예약 현황(오늘확정, 오늘이용, 오늘취소) 모니터링
"""

import time
import json
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service

# 네이버 로그인 정보
NAVER_ID = "blockchainmaster"
NAVER_PW = "LEEjr03311030!"
NAVER_URL = "https://partner.booking.naver.com/bizes/596871/booking-calendar-view"

# 모니터링 간격 (초)
MONITOR_INTERVAL = 300  # 5분

# 이전 상태 저장
previous_state = {
    "오늘확정": None,
    "오늘이용": None,
    "오늘취소": None
}

def log_message(msg):
    """메시지 로깅"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}")

def get_booking_status(driver):
    """예약 현황 숫자 추출"""
    try:
        # 예약현황 영역의 링크들을 찾음
        status = {}
        
        # "오늘 확정" 숫자 찾기
        today_confirmed = driver.find_element(By.XPATH, "//strong[contains(text(), '오늘 확정')]")
        status["오늘확정"] = today_confirmed.find_element(By.XPATH, "./preceding-sibling::strong").text
        
        # "오늘 이용" 숫자 찾기
        today_used = driver.find_element(By.XPATH, "//strong[contains(text(), '오늘 이용')]")
        status["오늘이용"] = today_used.find_element(By.XPATH, "./preceding-sibling::strong").text
        
        # "오늘 취소" 숫자 찾기
        today_cancelled = driver.find_element(By.XPATH, "//strong[contains(text(), '오늘 취소')]")
        status["오늘취소"] = today_cancelled.find_element(By.XPATH, "./preceding-sibling::strong").text
        
        return status
    except Exception as e:
        log_message(f"⚠️ 예약 현황 추출 실패: {e}")
        return None

def naver_login(driver):
    """네이버 로그인"""
    try:
        log_message("🔐 네이버 로그인 시작...")
        
        # 로그인 페이지 접속
        driver.get(NAVER_URL)
        
        # 로그인 필요한 경우
        try:
            # 아이디 입력
            id_input = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.ID, "id"))
            )
            id_input.send_keys(NAVER_ID)
            
            # 비밀번호 입력
            pw_input = driver.find_element(By.ID, "pw")
            pw_input.send_keys(NAVER_PW)
            
            # 로그인 버튼 클릭
            login_btn = driver.find_element(By.XPATH, "//button[contains(text(), '로그인')]")
            login_btn.click()
            
            # 페이지 로드 대기
            time.sleep(3)
            log_message("✅ 로그인 완료")
        except:
            log_message("✅ 이미 로그인된 상태")
            
    except Exception as e:
        log_message(f"❌ 로그인 실패: {e}")
        return False
    
    return True

def monitor_bookings(duration_minutes=120):
    """예약 현황 모니터링 (기본 2시간)"""
    
    log_message(f"🚀 예약 현황 모니터링 시작 ({duration_minutes}분)")
    
    # Chrome 드라이버 설정
    options = webdriver.ChromeOptions()
    # options.add_argument("--headless")  # 헤드리스 모드 (필요시 활성화)
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    
    driver = webdriver.Chrome(options=options)
    
    try:
        # 로그인
        if not naver_login(driver):
            return
        
        # 모니터링 시작
        start_time = time.time()
        duration_seconds = duration_minutes * 60
        
        while time.time() - start_time < duration_seconds:
            try:
                # 예약 현황 추출
                current_state = get_booking_status(driver)
                
                if current_state:
                    log_message(f"📊 현재 상태 - 오늘확정: {current_state['오늘확정']}, 오늘이용: {current_state['오늘이용']}, 오늘취소: {current_state['오늘취소']}")
                    
                    # 변경사항 감지
                    changed = False
                    for key in previous_state:
                        if previous_state[key] is not None and previous_state[key] != current_state[key]:
                            log_message(f"⚠️ 변경 감지! {key}: {previous_state[key]} → {current_state[key]}")
                            changed = True
                    
                    if changed:
                        # 변경사항 있으면 자세한 정보 캡처
                        log_message("📸 변경된 예약 정보 캡처 중...")
                        driver.save_screenshot(f"/Users/alexlee/.openclaw/workspace/booking-{datetime.now().strftime('%Y%m%d_%H%M%S')}.png")
                        log_message("✅ 스크린샷 저장 완료")
                    
                    # 상태 업데이트
                    previous_state.update(current_state)
                
                # 5분 대기
                log_message(f"⏳ 다음 확인: {MONITOR_INTERVAL}초 후")
                time.sleep(MONITOR_INTERVAL)
                
                # 페이지 새로고침
                driver.refresh()
                time.sleep(2)
                
            except KeyboardInterrupt:
                log_message("🛑 사용자에 의해 중단됨")
                break
            except Exception as e:
                log_message(f"❌ 오류 발생: {e}")
                time.sleep(MONITOR_INTERVAL)
        
        log_message("✅ 모니터링 완료 (시간 초과)")
        
    finally:
        driver.quit()
        log_message("🔌 드라이버 종료")

if __name__ == "__main__":
    monitor_bookings(duration_minutes=120)
