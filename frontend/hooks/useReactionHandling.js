// hooks/useReactionHandling.js

import { useCallback, useMemo } from "react";
import { Toast } from "../components/Toast";

export const useReactionHandling = (
  socketRef,
  currentUser,
  messages,
  setMessages
) => {
  // 메시지 찾기 로직 메모이제이션
  const findMessageReactions = useCallback(
    (messageId) => {
      return messages.find((m) => m._id === messageId)?.reactions || {};
    },
    [messages]
  );

  const handleReactionAdd = useCallback(
    async (messageId, reaction) => {
      try {
        if (!socketRef.current?.connected) {
          throw new Error("Socket not connected");
        }

        // 낙관적 업데이트
        setMessages((prevMessages) =>
          prevMessages.map((msg) => {
            if (msg._id === messageId) {
              const currentReactions = msg.reactions || {};
              const currentUsers = currentReactions[reaction] || [];

              // 중복 추가 방지
              if (!currentUsers.includes(currentUser.id)) {
                return {
                  ...msg,
                  reactions: {
                    ...currentReactions,
                    [reaction]: [...currentUsers, currentUser.id],
                  },
                };
              }
            }
            return msg;
          })
        );

        await socketRef.current.emit("messageReaction", {
          messageId,
          reaction,
          type: "add",
        });
      } catch (error) {
        console.error("Add reaction error:", error);
        Toast.error("리액션 추가에 실패했습니다.");

        // 롤백 로직 개선
        setMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg._id === messageId
              ? { ...msg, reactions: findMessageReactions(messageId) }
              : msg
          )
        );
      }
    },
    [socketRef, currentUser, messages, setMessages, findMessageReactions]
  );

  const handleReactionRemove = useCallback(
    async (messageId, reaction) => {
      try {
        if (!socketRef.current?.connected) {
          throw new Error("Socket not connected");
        }

        // 낙관적 업데이트
        setMessages((prevMessages) =>
          prevMessages.map((msg) => {
            if (msg._id === messageId) {
              const currentReactions = msg.reactions || {};
              const currentUsers = currentReactions[reaction] || [];
              return {
                ...msg,
                reactions: {
                  ...currentReactions,
                  [reaction]: currentUsers.filter(
                    (id) => id !== currentUser.id
                  ),
                },
              };
            }
            return msg;
          })
        );

        await socketRef.current.emit("messageReaction", {
          messageId,
          reaction,
          type: "remove",
        });
      } catch (error) {
        console.error("Remove reaction error:", error);
        Toast.error("리액션 제거에 실패했습니다.");

        // 롤백 로직 개선
        setMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg._id === messageId
              ? { ...msg, reactions: findMessageReactions(messageId) }
              : msg
          )
        );
      }
    },
    [socketRef, currentUser, messages, setMessages, findMessageReactions]
  );

  const handleReactionUpdate = useCallback(
    ({ messageId, reactions }) => {
      setMessages((prevMessages) =>
        prevMessages.map((msg) =>
          msg._id === messageId ? { ...msg, reactions } : msg
        )
      );
    },
    [setMessages]
  );

  return {
    handleReactionAdd,
    handleReactionRemove,
    handleReactionUpdate,
  };
};

export default useReactionHandling;
