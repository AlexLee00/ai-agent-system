'use strict';

const bookReviewBook = require('../../../packages/core/lib/skills/blog/book-review-book.ts');

describe('book review history', () => {
  afterEach(() => {
    bookReviewBook.setBookReviewQueuePgForTest(null);
  });

  test('linked book-review post remains deduplicated when schedule category drifted', async () => {
    const driftedHistory = [{
      schedule_id: 77,
      publish_date: '2026-07-10',
      book_title: '[POD] 기업교육 및 조직문화 개발 바로 세우기',
      book_author: '장기열',
      book_isbn: '9791137202153',
      status: 'published',
      schedule_category: '홈페이지와App',
      post_category: '도서리뷰',
    }];
    const query = jest.fn().mockResolvedValue(driftedHistory);
    bookReviewBook.setBookReviewQueuePgForTest({ query });

    const history = await bookReviewBook.loadReviewedBookHistory();
    const match = bookReviewBook.findReviewedBookMatch({
      title: '[POD] 기업교육 및 조직문화 개발 바로 세우기',
      isbn: '9791137202153',
    }, history);

    expect(match).toEqual(driftedHistory[0]);
    expect(query).toHaveBeenCalledWith(
      'blog',
      expect.stringContaining('LEFT JOIN blog.posts'),
    );
    expect(query.mock.calls[0][1]).toContain("s.category = '도서리뷰' OR p.category = '도서리뷰'");
  });

  test('current schedule is not treated as its own reviewed-book duplicate', () => {
    const history = [{
      schedule_id: 77,
      publish_date: '2026-07-10',
      book_title: '함께 자라기',
      book_author: '김창준',
      book_isbn: '9788966262335',
      status: 'ready',
    }];

    expect(bookReviewBook.findReviewedBookMatch({
      title: '함께 자라기',
      isbn: '9788966262335',
    }, history, { excludeScheduleId: 77 })).toBeNull();
    expect(bookReviewBook.findReviewedBookMatch({
      title: '함께 자라기',
      isbn: '9788966262335',
    }, history, { excludeScheduleId: 78 })).toEqual(history[0]);
  });

  test('curated book seed takes precedence over unrelated daily news', () => {
    const keywords = bookReviewBook.buildBookReviewSearchKeywords({
      topic: 'The lost joy of music piracy',
      preferredBooks: [{ title: '함께 자라기', author: '김창준' }],
    }, []);

    expect(keywords[0]).toBe('함께 자라기 김창준');
  });

  test('unknown books are not mislabeled as IT', () => {
    expect(bookReviewBook.inferCatalogCategory('한국기업의 구조조정과 새 조직문화개발')).toBe('기타');
  });
});
