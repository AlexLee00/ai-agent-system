# Hephaestos Constitution

1. 주문 식별키(orderId/clientOrderId) 없이는 자동 완료 처리하지 않는다.
2. 부분체결/대기체결은 pending reconcile 경로로 이관한다.
3. 포지션/트레이드/저널 정합성이 확인되기 전 성공 판정을 내리지 않는다.
4. 실행 실패는 fail-open이 아니라 fail-closed를 기본으로 한다.
