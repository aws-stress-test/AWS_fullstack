// test/load/load-testing.spec.ts
import { test, expect } from '@playwright/test';
import { TestHelpers } from '../helpers/test-helpers';

test.describe('부하 테스트', () => {
  const helpers = new TestHelpers();

  test('대량 메시지 처리', async ({ browser }) => {   
    const NUM_CLIENTS = 5000;
    const MESSAGES_PER_CLIENT = 200;
    const MESSAGE_INTERVAL = 10;

    const contexts = await Promise.all(
      Array.from({ length: NUM_CLIENTS }, () => browser.newContext())
    );
    
    const pages = await Promise.all(contexts.map(async (context, i) => {
      const page = await context.newPage();
      const creds = helpers.generateUserCredentials(i);
      await helpers.registerUser(page, creds);
      await helpers.joinOrCreateRoom(page, 'Load-Test');
      return page;
    }));

    const metrics = {
      totalMessages: 0,
      errors: 0,
      latencies: [],
      startTime: Date.now()
    };

    // 일반 채팅 메시지만 전송
    await Promise.all(pages.map(async (page, clientIndex) => {
      for (let i = 0; i < MESSAGES_PER_CLIENT; i++) {
        const messageStart = Date.now();
        try {
          await page.locator('.chat-input').fill(`Test message ${i + 1} from client ${clientIndex + 1}`);
          await page.locator('.send-button').click();
          metrics.totalMessages++;
          metrics.latencies.push(Date.now() - messageStart);
        } catch (error) {
          metrics.errors++;
        }
        await page.waitForTimeout(MESSAGE_INTERVAL);
      }
    }));

    const endTime = Date.now();
    const totalTime = endTime - metrics.startTime;
    const avgLatency = metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length;
    const messagesPerSecond = metrics.totalMessages / (totalTime / 1000);

    console.log(`
      테스트 결과:
      - 총 클라이언트: ${NUM_CLIENTS}
      - 성공한 메시지: ${metrics.totalMessages}
      - 실패한 메시지: ${metrics.errors}
      - 평균 지연시간: ${avgLatency.toFixed(2)}ms
      - 초당 메시지: ${messagesPerSecond.toFixed(2)}
      - 총 소요시간: ${totalTime}ms
    `);

    // 정리
    await Promise.all(pages.map(page => page.close()));
    await Promise.all(contexts.map(context => context.close()));
  });
});
