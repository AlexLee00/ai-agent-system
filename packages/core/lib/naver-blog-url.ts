type ParsedPathResult = {
  blogId: string;
  logNo: string;
  source: 'path' | 'query';
};

type ParseFailure = {
  ok: false;
  input: string;
  reason: string;
  hostname?: string;
  pathname?: string;
};

type ParseSuccess = {
  ok: true;
  input: string;
  blogId: string;
  logNo: string;
  hostname: string;
  source: 'path' | 'query';
  canonicalUrl: string;
  mobileUrl: string;
};

type ParseResult = ParseFailure | ParseSuccess;

function normalizeString(value: unknown): string {
  return String(value || '').trim();
}

function cleanBlogId(value: unknown): string | null {
  const blogId = normalizeString(value);
  return /^[a-zA-Z0-9._-]+$/.test(blogId) ? blogId : null;
}

function cleanLogNo(value: unknown): string | null {
  const logNo = normalizeString(value);
  return /^\d{5,20}$/.test(logNo) ? logNo : null;
}

function parseFromPath(hostname: string, pathname: string): ParsedPathResult | null {
  const parts = pathname.split('/').filter(Boolean);
  if ((hostname === 'blog.naver.com' || hostname === 'm.blog.naver.com') && parts.length >= 2) {
    const blogId = cleanBlogId(parts[0]);
    const logNo = cleanLogNo(parts[1]);
    if (blogId && logNo) {
      return { blogId, logNo, source: 'path' };
    }
  }
  return null;
}

function parseFromQuery(pathname: string, searchParams: URLSearchParams): ParsedPathResult | null {
  if (pathname !== '/PostView.naver') return null;
  const blogId = cleanBlogId(searchParams.get('blogId'));
  const logNo = cleanLogNo(searchParams.get('logNo'));
  if (blogId && logNo) {
    return { blogId, logNo, source: 'query' };
  }
  return null;
}

export function parseNaverBlogUrl(input: unknown): ParseResult {
  const raw = normalizeString(input);
  if (!raw) {
    return {
      ok: false,
      input: raw,
      reason: '빈 URL',
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      input: raw,
      reason: 'URL 파싱 실패',
    };
  }

  const hostname = normalizeString(url.hostname).toLowerCase();
  const isNaverBlogHost = hostname === 'blog.naver.com' || hostname === 'm.blog.naver.com';
  if (!isNaverBlogHost) {
    return {
      ok: false,
      input: raw,
      reason: '네이버 블로그 URL이 아님',
      hostname,
    };
  }

  const parsed = parseFromPath(hostname, url.pathname) || parseFromQuery(url.pathname, url.searchParams);
  if (!parsed) {
    return {
      ok: false,
      input: raw,
      reason: 'blogId/logNo 추출 실패',
      hostname,
      pathname: url.pathname,
    };
  }

  const canonicalUrl = `https://blog.naver.com/${parsed.blogId}/${parsed.logNo}`;
  const mobileUrl = `https://m.blog.naver.com/${parsed.blogId}/${parsed.logNo}`;

  return {
    ok: true,
    input: raw,
    blogId: parsed.blogId,
    logNo: parsed.logNo,
    hostname,
    source: parsed.source,
    canonicalUrl,
    mobileUrl,
  };
}

export function isNaverBlogUrl(input: unknown): boolean {
  return parseNaverBlogUrl(input).ok === true;
}
