// test/load/load-testing.spec.ts
import { test, expect } from '@playwright/test';
import { TestHelpers } from '../helpers/test-helpers';

// 테스트 타임아웃 설정
test.setTimeout(1800000); // 30분

interface Metrics {
  totalMessages: number;
  errors: number;
  latencies: number[];
  startTime: number;
  activeConnections: number;
}

test.describe('부하 테스트', () => {
  const helpers = new TestHelpers();

  test('점진적 부하 증가 테스트', async ({ browser }) => {   
    // 총 메시지 3000개를 목표로 한 설정
    const INITIAL_CLIENTS = 30;       // 30명으로 시작
    const CLIENT_INCREMENT = 30;      // 30명씩 증가
    const INCREMENT_INTERVAL = 20000; // 20초 간격
    const MAX_CLIENTS = 300;         // 최대 300명까지
    const MESSAGES_PER_CLIENT = 20;   // 클라이언트당 20개 메시지
    const MESSAGE_INTERVAL = 150;     // 150ms 간격
    const BATCH_SIZE = 15;           // 15명씩 처리
    const MAX_TEST_DURATION = 600000; // 10분

    // 인스턴스 관련 설정
    const TOTAL_INSTANCES = 30;
    const CLIENTS_PER_INSTANCE = Math.ceil(MAX_CLIENTS / TOTAL_INSTANCES); // 인스턴스당 최대 클라이언트

    const metrics: Metrics = {
      totalMessages: 0,
      errors: 0,
      latencies: [],
      startTime: Date.now(),
      activeConnections: 0
    };

    // 클라이언트 생성 및 연결 함수
    async function createClients(startIndex: number, count: number) {
      const batchSize = Math.min(BATCH_SIZE, count);
      const contexts = await Promise.all(
        Array.from({ length: batchSize }, () => browser.newContext())
      );
      
      const pages = await Promise.all(contexts.map(async (context, idx) => {
        try {
          const page = await context.newPage();
          const creds = helpers.generateUserCredentials(startIndex + idx);
          
          // 기존 회원가입 및 채팅방 입장 로직
          await page.goto('/register');
          await page.locator('#name').fill(creds.name);
          await page.locator('#email').fill(creds.email);
          await page.locator('#password').fill(creds.password);
          await page.locator('#confirmPassword').fill(creds.password);
          
          await page.locator('form button[type="submit"]').click();
          await page.waitForSelector('.modal-header:has-text("회원가입 성공")');
          await page.getByRole('button', { name: '채팅방 목록으로 이동' }).click();
          
          await page.waitForURL('/chat-rooms');
          await page.waitForLoadState('networkidle');
          
          const roomExists = await page.getByText('Load-Test').isVisible().catch(() => false);
          
          if (!roomExists) {
            await page.locator('button.btn.btn-primary:has-text("새 채팅방")').click();
            await page.waitForURL('/chat-rooms/new');
            await page.locator('#roomName').fill('Load-Test');
            await page.locator('form button[type="submit"]').click();
          } else {
            await page.getByText('Load-Test').click();
          }
          
          await page.waitForURL('**/chat?room=**');
          await page.waitForSelector('.chat-messages');
          await page.waitForLoadState('networkidle');
          
          metrics.activeConnections++;
          return page;
        } catch (error) {
          console.error('Client creation error:', error);
          metrics.errors++;
          return null;
        }
      }));

      return pages.filter(page => page !== null);
    }

    // 메시지 전송 함수
    async function sendMessages(pages: any[], startIndex: number) {
      await Promise.all(pages.map(async (page, clientIndex) => {
        try {
          for (let j = 0; j < MESSAGES_PER_CLIENT; j++) {
            const messageStart = Date.now();
            try {
              await page.locator('.chat-input .chat-input-main textarea').fill(
                `Test message ${j + 1} from client ${startIndex + clientIndex + 1}`
              );
              await page.locator('.chat-input .chat-input-actions > button').click();
              metrics.totalMessages++;
              metrics.latencies.push(Date.now() - messageStart);
              await page.waitForTimeout(MESSAGE_INTERVAL);
            } catch (error) {
              metrics.errors++;
              console.error('Message send error:', error);
            }
          }
        } catch (error) {
          console.error('Client error:', error);
        }
      }));
    }

    // 메인 테스트 로직
    let currentClients = 0;
    while (currentClients < MAX_CLIENTS) {
      const newClients = Math.min(CLIENT_INCREMENT, MAX_CLIENTS - currentClients);
      console.log(`Creating ${newClients} new clients. Total: ${currentClients + newClients}`);
      
      const pages = await createClients(currentClients, newClients);
      await sendMessages(pages, currentClients);
      
      // 중간 결과 출력
      const currentTime = Date.now();
      const elapsedTime = currentTime - metrics.startTime;
      const estimatedTimeRemaining = ((MAX_CLIENTS - currentClients) / CLIENT_INCREMENT) * INCREMENT_INTERVAL;
      const currentAvgLatency = metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length;
      
      console.log(`
        중간 상태:
        - 현재 접속자: ${metrics.activeConnections}
        - 예상 남은 시간: ${(estimatedTimeRemaining / 1000).toFixed(0)}초
        - 경과 시간: ${(elapsedTime / 1000).toFixed(0)}초
        - 초당 메시지: ${(metrics.totalMessages / (elapsedTime / 1000)).toFixed(2)}
      `);

      // 다음 배치 전 대기
      await new Promise(resolve => setTimeout(resolve, INCREMENT_INTERVAL));
      currentClients += newClients;
    }

    // 최종 결과 출력
    const endTime = Date.now();
    const totalTime = endTime - metrics.startTime;
    const avgLatency = metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length;
    const messagesPerSecond = metrics.totalMessages / (totalTime / 1000);

    console.log(`
      최종 테스트 결과:
      - 최대 동시 접속자: ${metrics.activeConnections}
      - 총 메시지: ${metrics.totalMessages}
      - 실패: ${metrics.errors}
      - 평균 지연시간: ${avgLatency.toFixed(2)}ms
      - 초당 메시지: ${messagesPerSecond.toFixed(2)}
      - 총 소요시간: ${(totalTime / 1000).toFixed(0)}초
    `);
  });
});
