// test/basic-functionality.spec.ts
import { test, expect } from '@playwright/test';
import { TestHelpers } from '../helpers/test-helpers';

test.describe('기본 기능 테스트', () => {
  const helpers = new TestHelpers();

  test('방 참여, 메시지 전송 및 수신 확인', async ({ browser }) => {
    // 첫 번째 사용자 (방장)
    const user1 = await browser.newPage();
    const user1Creds = helpers.generateUserCredentials(Math.floor(Math.random() * 1001));
    await helpers.registerUser(user1, user1Creds);
    const roomName = await helpers.joinOrCreateRoom(user1, 'BasicTestRoom');
    const user1Url = user1.url();
    const user1RoomParam = new URLSearchParams(new URL(user1Url).search).get('room');
    if (!user1RoomParam) throw new Error('Room parameter not found');

    // 두 번째 사용자 (참가자)
    const user2 = await browser.newPage();
    const user2Creds = helpers.generateUserCredentials(Math.floor(Math.random() * 1001));
    await helpers.registerUser(user2, user2Creds);
    await helpers.joinRoomByURLParam(user2, user1RoomParam);

    // 참여자 수 확인 (2명)
    await expect(user1.locator('.participants-count')).toContainText('2');
    await expect(user2.locator('.participants-count')).toContainText('2');

    // 메시지 전송 테스트
    const testMessage = '안녕하세요, Playwright 테스트 메시지입니다.';
    await user1.fill('.chat-input-textarea', testMessage);
    await user1.click('.send-button');

    // 두 번째 사용자 측에서 메시지 수신 대기
    // 예: .message-list .message-item:last-child에 testMessage 반영
    await expect(user2.locator('.message-list .message-item:last-child')).toContainText(testMessage);

    // 테스트 종료 전 리소스 정리
    await user2.close();
    await user1.close();
  });
});
