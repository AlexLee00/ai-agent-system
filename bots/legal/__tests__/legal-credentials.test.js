'use strict';

jest.mock('../../../packages/core/lib/hub-client', () => ({
  fetchHubSecrets: jest.fn(),
}));

const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');
const fs = require('fs');
const originalReadFileSync = fs.readFileSync.bind(fs);

// legal-credentials는 내부 캐시(localJustinSecretsCache)를 가지므로
// 각 테스트에서 모듈 재로드하여 캐시 초기화
let creds;

function reloadCreds() {
  jest.isolateModules(() => {
    // hub-client는 이미 모킹됨 — 재로드해도 mock 유지
    creds = require('../../../packages/core/lib/legal-credentials.js');
  });
}

describe('legal-credentials', () => {
  let readFileSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    // secrets-store.json 경로만 선택적으로 인터셉트
    readFileSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      if (String(filePath).endsWith('secrets-store.json')) {
        return JSON.stringify({});
      }
      return originalReadFileSync(filePath, ...args);
    });
    reloadCreds();
  });

  afterEach(() => {
    readFileSpy.mockRestore();
  });

  describe('resolveKoreaLawCredentials', () => {
    test('Hub 시크릿 우선 — Hub에서 oc/baseUrl/userId/userName 반환', async () => {
      fetchHubSecrets.mockResolvedValue({
        korea_law: { oc: 'HUB_OC', base_url: 'https://hub.law.kr', user_id: 'huid', user_name: 'hname' },
      });

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.oc).toBe('HUB_OC');
      expect(result.baseUrl).toBe('https://hub.law.kr');
      expect(result.userId).toBe('huid');
      expect(result.userName).toBe('hname');
    });

    test('환경변수 최우선 — JUSTIN_LAW_API_OC env 사용', async () => {
      process.env.JUSTIN_LAW_API_OC = 'ENV_OC';
      process.env.JUSTIN_LAW_API_BASE_URL = 'https://env.law.kr';
      process.env.JUSTIN_LAW_API_USER_ID = 'env_uid';
      process.env.JUSTIN_LAW_API_USER_NAME = 'env_uname';
      fetchHubSecrets.mockResolvedValue({ korea_law: { oc: 'HUB_OC' } });

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.oc).toBe('ENV_OC');
      expect(result.baseUrl).toBe('https://env.law.kr');
      expect(result.userId).toBe('env_uid');
      expect(result.userName).toBe('env_uname');

      delete process.env.JUSTIN_LAW_API_OC;
      delete process.env.JUSTIN_LAW_API_BASE_URL;
      delete process.env.JUSTIN_LAW_API_USER_ID;
      delete process.env.JUSTIN_LAW_API_USER_NAME;
    });

    test('Hub 실패 시 로컬 secrets-store.json 폴백', async () => {
      fetchHubSecrets.mockRejectedValue(new Error('hub timeout'));
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          return JSON.stringify({
            justin: { korea_law: { oc: 'LOCAL_OC', base_url: 'https://local.law.kr', user_id: 'luid', user_name: 'lname' } },
          });
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.oc).toBe('LOCAL_OC');
      expect(result.baseUrl).toBe('https://local.law.kr');
      expect(result.userId).toBe('luid');
    });

    test('Hub null 반환 시 로컬 폴백', async () => {
      fetchHubSecrets.mockResolvedValue(null);
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          return JSON.stringify({ justin: { korea_law: { oc: 'LOC2', user_id: 'lu2', user_name: 'ln2' } } });
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.oc).toBe('LOC2');
    });

    test('Hub + 로컬 모두 실패 — 빈 문자열 반환 (throw 없음)', async () => {
      fetchHubSecrets.mockRejectedValue(new Error('fail'));
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          throw new Error('no file');
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.oc).toBe('');
      expect(result.baseUrl).toBe('https://www.law.go.kr');
      expect(result.userId).toBe('');
      expect(result.userName).toBe('');
    });

    test('로컬 JSON 파싱 오류 — 빈 캐시로 처리', async () => {
      fetchHubSecrets.mockRejectedValue(new Error('fail'));
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          return 'INVALID_JSON';
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.oc).toBe('');
    });

    test('korea_law_api 폴백 키도 지원', async () => {
      fetchHubSecrets.mockResolvedValue(null);
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          return JSON.stringify({ justin: { korea_law_api: { oc: 'API_OC' } } });
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.oc).toBe('API_OC');
    });

    test('기본 baseUrl — https://www.law.go.kr', async () => {
      fetchHubSecrets.mockResolvedValue({ korea_law: { oc: 'OC1' } });

      const result = await creds.resolveKoreaLawCredentials();

      expect(result.baseUrl).toBe('https://www.law.go.kr');
    });
  });

  describe('loadLocalJustinSecrets', () => {
    test('secrets-store.json justin 섹션 반환', () => {
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          return JSON.stringify({ justin: { foo: 'bar' } });
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = creds.loadLocalJustinSecrets();
      expect(result).toEqual({ foo: 'bar' });
    });

    test('justin 키 없으면 빈 객체', () => {
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          return JSON.stringify({ other: {} });
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = creds.loadLocalJustinSecrets();
      expect(result).toEqual({});
    });

    test('파일 없으면 빈 객체', () => {
      readFileSpy.mockImplementation((filePath, ...args) => {
        if (String(filePath).endsWith('secrets-store.json')) {
          throw new Error('no file');
        }
        return originalReadFileSync(filePath, ...args);
      });
      reloadCreds();

      const result = creds.loadLocalJustinSecrets();
      expect(result).toEqual({});
    });
  });

  describe('fetchHubJustinSecrets', () => {
    test('Hub에서 justin 시크릿 반환', async () => {
      fetchHubSecrets.mockResolvedValue({ korea_law: { oc: 'X' } });

      const result = await creds.fetchHubJustinSecrets();
      expect(result).toEqual({ korea_law: { oc: 'X' } });
      expect(fetchHubSecrets).toHaveBeenCalledWith('justin', 3000);
    });

    test('Hub null 반환 시 null 반환', async () => {
      fetchHubSecrets.mockResolvedValue(null);

      const result = await creds.fetchHubJustinSecrets();
      expect(result).toBeNull();
    });

    test('타임아웃 파라미터 전달', async () => {
      fetchHubSecrets.mockResolvedValue({});

      await creds.fetchHubJustinSecrets(5000);
      expect(fetchHubSecrets).toHaveBeenCalledWith('justin', 5000);
    });
  });
});
