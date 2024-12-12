// test/load/load-testing.spec.ts
import { test, expect } from "@playwright/test";
import { TestHelpers } from "../helpers/test-helpers";

// 테스트 타임아웃 설정
test.setTimeout(600000); // 10분

interface Metrics {
  totalMessages: number;
  errors: number;
  latencies: number[];
  startTime: number;
}

test.describe("부하 테스트", () => {
  const helpers = new TestHelpers();

  test("대량 메시지 처리", async ({ browser }) => {
    // // 부하 테스트 설정 부하테스트
    // const NUM_CLIENTS = 3000;        // 50 -> 3000 (동시 접속 클라이언트 수)
    // const MESSAGES_PER_CLIENT = 20;  // 클라이언트당 전송할 메시지 수
    // const MESSAGE_INTERVAL = 100;    // 메시지 전송 간격 ms
    // const BATCH_SIZE = 100;          // 10 -> 100 (한 번에 생성할 클라이언트 수)

    // 부하 테스트 설정
    const NUM_CLIENTS = 50; // 동시 접속 클라이언트 수
    const MESSAGES_PER_CLIENT = 20; // 클라이언트당 전송할 메시지 수
    const MESSAGE_INTERVAL = 100; // 메시지 전송 간격 (ms)
    const BATCH_SIZE = 10; // 한 번에 생성할 클라이언트 수

    const metrics: Metrics = {
      totalMessages: 0,
      errors: 0,
      latencies: [],
      startTime: Date.now(),
    };

    for (let i = 0; i < NUM_CLIENTS; i += BATCH_SIZE) {
      const batchSize = Math.min(BATCH_SIZE, NUM_CLIENTS - i);

      const contexts = await Promise.all(
        Array.from({ length: batchSize }, () => browser.newContext())
      );

      const pages = await Promise.all(
        contexts.map(async (context, idx) => {
          const page = await context.newPage();
          const creds = helpers.generateUserCredentials(i + idx);

          // 회원가입
          await page.goto("/register");
          await page.locator("#name").fill(creds.name);
          await page.locator("#email").fill(creds.email);
          await page.locator("#password").fill(creds.password);
          await page.locator("#confirmPassword").fill(creds.password);

          // 폼 내부의 제출 버튼 클릭
          await page.locator('form button[type="submit"]').click();

          // 회원가입 성공 모달 처리
          await page.waitForSelector('.modal-header:has-text("회원가입 성공")');
          await page
            .getByRole("button", { name: "채팅방 목록으로 이동" })
            .click();

          // 채팅방 목록 페이지 로드 대기
          await page.waitForURL("/chat-rooms");
          await page.waitForLoadState("networkidle");

          // 채팅방 생성 또는 입장
          const roomExists = await page
            .getByText("Load-Test")
            .isVisible()
            .catch(() => false);

          if (!roomExists) {
            // nav-menu > nav-buttons의 "새 채팅방" 버튼 클릭
            await page
              .locator('button.btn.btn-primary:has-text("새 채팅방")')
              .click();

            await page.waitForURL("/chat-rooms/new");
            await page.locator("#roomName").fill("Load-Test");

            // 채팅방 생성 페이지의 '채팅방 만들기' 버튼
            await page.locator('form button[type="submit"]').click();
          } else {
            await page.getByText("Load-Test").click();
          }

          // 채팅방 입장 대기
          await page.waitForURL("**/chat?room=**");
          await page.waitForSelector(".chat-messages");
          await page.waitForLoadState("networkidle");

          return page;
        })
      );

      // 메시지 전송
      await Promise.all(
        pages.map(async (page, clientIndex) => {
          try {
            for (let j = 0; j < MESSAGES_PER_CLIENT; j++) {
              const messageStart = Date.now();
              try {
                await page
                  .locator(".chat-input .chat-input-main textarea")
                  .fill(
                    `Test message ${j + 1} from client ${i + clientIndex + 1}`
                  );
                await page
                  .locator(".chat-input .chat-input-actions > button")
                  .click();
                metrics.totalMessages++;
                metrics.latencies.push(Date.now() - messageStart);
                await page.waitForTimeout(MESSAGE_INTERVAL);
              } catch (error) {
                metrics.errors++;
                console.error("Message send error:", error);
              }
            }
          } catch (error) {
            console.error("Client error:", error);
          }
        })
      );

      // 모든 메시지 전송이 완료된 후에 페이지와 컨텍스트를 닫음
      await Promise.all(pages.map((page) => page.close()));
      await Promise.all(contexts.map((context) => context.close()));

      // 다음 배치 전에 잠시 대기
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const endTime = Date.now();
    const totalTime = endTime - metrics.startTime;
    const avgLatency =
      metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length;
    const messagesPerSecond = metrics.totalMessages / (totalTime / 1000);

    console.log(`
      테스트 결과:
      - 총 클라이언트: ${NUM_CLIENTS}
      - 성공한 메시지: ${metrics.totalMessages}
      - 실패한 메시지: ${metrics.errors}
      - 평균 지연시간: ${avgLatency.toFixed(2)}ms
      - 1초당 메시지: ${messagesPerSecond.toFixed(2)}
      - 총 소요시간: ${totalTime}ms
    `);
  });
});
