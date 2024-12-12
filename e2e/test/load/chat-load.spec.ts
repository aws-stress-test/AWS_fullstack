import { test, expect } from '@playwright/test';
import { TestHelpers } from '../helpers/test-helpers';

test.describe('채팅 부하 테스트', () => {
  const helpers = new TestHelpers();

  test('동시 접속 및 메시지 처리 테스트', async ({ browser }) => {
    const NUM_CLIENTS = 50;  // 50명 동시 접속
    const MESSAGES_PER_CLIENT = 100; // 각 클라이언트당 100개 메시지
    const MESSAGE_INTERVAL = 5; // 메시지 전송 간격 5ms
    
    // 여러 브라우저 컨텍스트 생성
    const contexts = await Promise.all(
      Array.from({ length: NUM_CLIENTS }, () => browser.newContext())
    );
    
    // 각 컨텍스트에 대해 페이지 생성 및 로그인
    const pages = await Promise.all(contexts.map(async (context, i) => {
      const page = await context.newPage();
      const creds = helpers.generateUserCredentials(i);
      await helpers.registerUser(page, creds);
      await helpers.joinOrCreateRoom(page, 'load-test-room');
      return page;
    }));

    const startTime = Date.now();

    // 각 클라이언트가 동시에 메시지 전송
    await Promise.all(pages.map(async (page, clientIndex) => {
      for (let i = 0; i < MESSAGES_PER_CLIENT; i++) {
        await helpers.sendMessage(
          page, 
          `Message ${i + 1} from client ${clientIndex + 1}`
        );
        await page.waitForTimeout(MESSAGE_INTERVAL);
      }
    }));

    const endTime = Date.now();
    const totalTime = endTime - startTime;
    const totalMessages = NUM_CLIENTS * MESSAGES_PER_CLIENT;
    const messagesPerSecond = totalMessages / (totalTime / 1000);

    console.log(`
      테스트 결과:
      - 총 클라이언트: ${NUM_CLIENTS}
      - 총 메시지: ${totalMessages}
      - 소요 시간: ${totalTime}ms
      - 초당 메시지: ${messagesPerSecond.toFixed(2)}
    `);

    // 메시지 수신 확인
    for (const page of pages) {
      const messages = await page.locator('.message-content').all();
      expect(messages.length).toBeGreaterThanOrEqual(MESSAGES_PER_CLIENT);
    }

    // 정리
    await Promise.all(pages.map(page => page.close()));
    await Promise.all(contexts.map(context => context.close()));
  });

  // 장시간 부하 테스트
  test.skip('장시간 부하 테스트', async ({ browser }) => {
    const DURATION = 5 * 60 * 1000; // 5분
    const NUM_CLIENTS = 20;
    const MESSAGE_INTERVAL = 1000; // 1초마다 메시지 전송
    
    const contexts = await Promise.all(
      Array.from({ length: NUM_CLIENTS }, () => browser.newContext())
    );
    
    const pages = await Promise.all(contexts.map(async (context, i) => {
      const page = await context.newPage();
      const creds = helpers.generateUserCredentials(i);
      await helpers.registerUser(page, creds);
      await helpers.joinOrCreateRoom(page, 'long-test-room');
      return page;
    }));

    const startTime = Date.now();
    let messageCount = 0;

    while (Date.now() - startTime < DURATION) {
      await Promise.all(pages.map(async (page, clientIndex) => {
        await helpers.sendMessage(
          page,
          `Long test message ${++messageCount} from client ${clientIndex + 1}`
        );
      }));
      await pages[0].waitForTimeout(MESSAGE_INTERVAL);
    }

    // 결과 확인
    const endTime = Date.now();
    const totalTime = endTime - startTime;
    console.log(`
      장시간 테스트 결과:
      - 총 클라이언트: ${NUM_CLIENTS}
      - 총 메시지: ${messageCount}
      - 소요 시간: ${totalTime}ms
      - 초당 메시지: ${(messageCount / (totalTime / 1000)).toFixed(2)}
    `);

    await Promise.all(pages.map(page => page.close()));
    await Promise.all(contexts.map(context => context.close()));
  });

  // 스파이크 부하 테스트
  test.skip('스파이크 부하 테스트', async ({ browser }) => {
    const INITIAL_CLIENTS = 10;
    const SPIKE_CLIENTS = 100;
    const MESSAGES_PER_CLIENT = 20;
    const MESSAGE_INTERVAL = 100;

    // 초기 클라이언트 설정
    const initialContexts = await Promise.all(
      Array.from({ length: INITIAL_CLIENTS }, () => browser.newContext())
    );
    
    const initialPages = await Promise.all(initialContexts.map(async (context, i) => {
      const page = await context.newPage();
      const creds = helpers.generateUserCredentials(i);
      await helpers.registerUser(page, creds);
      await helpers.joinOrCreateRoom(page, 'spike-test-room');
      return page;
    }));

    // 초기 부하 생성
    await Promise.all(initialPages.map(async (page, clientIndex) => {
      for (let i = 0; i < MESSAGES_PER_CLIENT; i++) {
        await helpers.sendMessage(
          page,
          `Initial message ${i + 1} from client ${clientIndex + 1}`
        );
        await page.waitForTimeout(MESSAGE_INTERVAL);
      }
    }));

    // 스파이크 부하 생성
    const spikeContexts = await Promise.all(
      Array.from({ length: SPIKE_CLIENTS - INITIAL_CLIENTS }, () => browser.newContext())
    );
    
    const spikePages = await Promise.all(spikeContexts.map(async (context, i) => {
      const page = await context.newPage();
      const creds = helpers.generateUserCredentials(i + INITIAL_CLIENTS);
      await helpers.registerUser(page, creds);
      await helpers.joinOrCreateRoom(page, 'spike-test-room');
      return page;
    }));

    const startTime = Date.now();

    // 모든 클라이언트가 동시에 메시지 전송
    await Promise.all([...initialPages, ...spikePages].map(async (page, clientIndex) => {
      for (let i = 0; i < MESSAGES_PER_CLIENT; i++) {
        await helpers.sendMessage(
          page,
          `Spike message ${i + 1} from client ${clientIndex + 1}`
        );
        await page.waitForTimeout(MESSAGE_INTERVAL);
      }
    }));

    const endTime = Date.now();
    const totalTime = endTime - startTime;
    const totalMessages = SPIKE_CLIENTS * MESSAGES_PER_CLIENT;

    console.log(`
      스파이크 테스트 결과:
      - 초기 클라이언트: ${INITIAL_CLIENTS}
      - 최종 클라이언트: ${SPIKE_CLIENTS}
      - 총 메시지: ${totalMessages}
      - 소요 시간: ${totalTime}ms
      - 초당 메시지: ${(totalMessages / (totalTime / 1000)).toFixed(2)}
    `);

    // 정리
    await Promise.all([...initialPages, ...spikePages].map(page => page.close()));
    await Promise.all([...initialContexts, ...spikeContexts].map(context => context.close()));
  });
}); 