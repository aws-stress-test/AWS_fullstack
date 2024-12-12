import { PlaywrightTestConfig, devices } from '@playwright/test';

const config: PlaywrightTestConfig = {
  testDir: './test',
  timeout: 60000,
  expect: { 
    timeout: 20000
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,  // 부하 테스트는 단일 워커로 실행
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 60000,  // 액션 타임아웃 설정
    navigationTimeout: 60000, // 네비게이션 타임아웃 설정
    video: 'retain-on-failure' // 실패 시 비디오 저장
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'load-tests',
      testMatch: /.*load.*\.spec\.ts/,
      timeout: 120000, // 부하 테스트는 더 긴 타임아웃이 필요할 수 있음
    },
  ],
};

export default config;