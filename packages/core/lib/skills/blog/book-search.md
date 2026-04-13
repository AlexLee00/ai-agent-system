# Blog Skill: Book Search

목표:
- 도서리뷰에서 실제 존재하는 책과 검증된 메타데이터만 사용한다.

현재 운영 소스:
- data4library 인기대출
- data4library 추천도서
- Naver Book
- Google Books
- Kakao Book
- Open Library
- book_catalog / book_review_queue

필수 규칙:
- ISBN 또는 교차 검증 가능한 메타데이터를 우선한다.
- book_catalog와 queue 우선순위를 먼저 본다.
- IT 편중을 피하고 인문학/소설/자기계발을 함께 고려한다.
- 최근 리뷰한 책/저자는 패널티를 준다.

