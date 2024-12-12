import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import authService from "../services/authService";
import socketService from "../services/socket";
import { useFileHandling } from "./useFileHandling";
import { useMessageHandling } from "./useMessageHandling";
import { useReactionHandling } from "./useReactionHandling";
import { useAIMessageHandling } from "./useAIMessageHandling";
import { useScrollHandling } from "./useScrollHandling";
import { useSocketHandling } from "./useSocketHandling";
import { useRoomHandling } from "./useRoomHandling";
import { Toast } from "../components/Toast";

const CLEANUP_REASONS = {
  DISCONNECT: "disconnect",
  MANUAL: "manual",
  RECONNECT: "reconnect",
  UNMOUNT: "unmount",
  ERROR: "error",
};

export const useChatRoom = () => {
  const router = useRouter();
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("checking");
  const [messageLoadError, setMessageLoadError] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Refs
  const messageInputRef = useRef(null);
  const messageLoadAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  const initializingRef = useRef(false);
  const setupCompleteRef = useRef(false);
  const socketInitializedRef = useRef(false);
  const cleanupInProgressRef = useRef(false);
  const userRooms = useRef(new Map());
  const processedMessageIds = useRef(new Set());

  // Socket handling setup
  const {
    connected,
    socketRef,
    handleConnectionError,
    handleReconnect,
    setConnected,
  } = useSocketHandling(router);

  // Scroll handling hook
  const {
    isNearBottom,
    hasMoreMessages,
    loadingMessages,
    messagesEndRef,
    scrollToBottom,
    handleScroll,
    setHasMoreMessages,
    setLoadingMessages,
  } = useScrollHandling(socketRef, router, messages);

  // AI Message handling hook
  const {
    streamingMessages,
    setStreamingMessages,
    handleAIMessageStart,
    handleAIMessageChunk,
    handleAIMessageComplete,
    handleAIMessageError,
    setupAIMessageListeners,
  } = useAIMessageHandling(
    socketRef,
    setMessages,
    isNearBottom,
    scrollToBottom
  );

  // Message handling hook
  const {
    message,
    showEmojiPicker,
    showMentionList,
    mentionFilter,
    mentionIndex,
    filePreview,
    uploading,
    uploadProgress,
    uploadError,
    setMessage,
    setShowEmojiPicker,
    setShowMentionList,
    setMentionFilter,
    setMentionIndex,
    setFilePreview,
    handleMessageChange,
    handleMessageSubmit,
    handleLoadMore,
    handleEmojiToggle,
    getFilteredParticipants,
    insertMention,
    removeFilePreview,
  } = useMessageHandling(socketRef, currentUser, router);

  // 메시지 처리 유틸리티 함수
  const processMessages = useCallback(
    (loadedMessages, hasMore, isInitialLoad = false) => {
      try {
        if (!Array.isArray(loadedMessages)) {
          throw new Error("Invalid messages format");
        }

        setMessages((prev) => {
          // 중복 필터링 및 정렬
          const messageMap = new Map([...prev.map(msg => [msg._id, msg])]);
          loadedMessages.forEach(msg => {
            if (msg._id && !messageMap.has(msg._id)) {
              messageMap.set(msg._id, msg);
            }
          });
          
          return Array.from(messageMap.values()).sort((a, b) => 
            new Date(a.timestamp) - new Date(b.timestamp)
          );
        });

        if (isInitialLoad) {
          setHasMoreMessages(hasMore);
          if (isNearBottom) {
            requestAnimationFrame(() => scrollToBottom("auto"));
          }
        } else {
          setHasMoreMessages(hasMore);
        }
      } catch (error) {
        console.error("Message processing error:", error);
        throw error;
      }
    },
    [setMessages, setHasMoreMessages, isNearBottom, scrollToBottom]
  );

  // Event listeners setup
  const setupEventListeners = useCallback(() => {
    if (!socketRef.current || !mountedRef.current) return;

    console.log("Setting up event listeners...");

    // 메시지 이벤트 리스너
    const handleNewMessage = (message) => {
      if (!message || !mountedRef.current || !message._id) return;

      setMessages(prev => {
        // 이미 존재하는 메시지인지 확인
        if (prev.some(msg => msg._id === message._id)) return prev;
        return [...prev, message];
      });

      if (isNearBottom) {
        scrollToBottom();
      }
    };

    // 이전 메시지 이벤트 리스너
    const handlePreviousMessages = (response) => {
      if (!mountedRef.current) return;

      try {
        if (!response || typeof response !== "object") {
          throw new Error("Invalid response format");
        }

        const { messages: loadedMessages = [], hasMore } = response;
        const isInitialLoad = messages.length === 0;

        processMessages(loadedMessages, hasMore, isInitialLoad);
        setLoadingMessages(false);
      } catch (error) {
        console.error("Error processing messages:", error);
        setLoadingMessages(false);
        setError("메시지 처리 중 오류가 발생했습니다.");
        setHasMoreMessages(false);
      }
    };

    // 이벤트 리스너 등록
    socketRef.current.on("message", handleNewMessage);
    socketRef.current.on("previousMessages", handlePreviousMessages);
    
    // AI 메시지 리스너 설정
    setupAIMessageListeners();

    // 리액션 이벤트
    socketRef.current.on("messageReactionUpdate", (data) => {
      if (!mountedRef.current) return;
      handleReactionUpdate(data);
    });

    // 세션 관련 이벤트
    socketRef.current.on("session_ended", () => {
      if (!mountedRef.current) return;
      cleanup();
      authService.logout();
      router.replace("/?error=session_expired");
    });

    socketRef.current.on("error", (error) => {
      if (!mountedRef.current) return;
      console.error("Socket error:", error);
      setError(error.message || "채팅 연결에 문제가 발생했습니다.");
    });

    // cleanup 함수 반환
    return () => {
      if (socketRef.current) {
        socketRef.current.off("message", handleNewMessage);
        socketRef.current.off("previousMessages", handlePreviousMessages);
        socketRef.current.off("messageReactionUpdate");
        socketRef.current.off("session_ended");
        socketRef.current.off("error");
      }
    };
  }, [
    isNearBottom,
    scrollToBottom,
    messages.length,
    processMessages,
    setupAIMessageListeners,
    setHasMoreMessages,
    cleanup,
    router,
    handleReactionUpdate,
    setLoadingMessages,
    setError,
  ]);

  // 이벤트 리스너를 직접 연결하는 useEffect 추가
  useEffect(() => {
    if (socketRef.current && connected && !initializingRef.current) {
      console.log("Setting up event listeners from useEffect");
      const cleanupListeners = setupEventListeners();
      return () => {
        cleanupListeners?.();
      };
    }
  }, [socketRef.current, connected, setupEventListeners]);

  // Socket connection monitoring
  useEffect(() => {
    if (!socketRef.current || !currentUser) return;

    const handleConnect = () => {
      if (!mountedRef.current) return;
      console.log("Socket connected successfully");
      setConnectionStatus("connected");
      setConnected(true);

      if (router.query.room && !setupCompleteRef.current && !initializingRef.current && !isInitialized) {
        socketInitializedRef.current = true;
        setupRoom().catch((error) => {
          console.error("Setup room error:", error);
          setError("채팅방 연결에 실패했습니다.");
        });
      }
    };

    const handleDisconnect = () => {
      if (!mountedRef.current) return;
      console.log("Socket disconnected");
      setConnectionStatus("disconnected");
      setConnected(false);
    };

    // 연결 관련 이벤트만 처리
    socketRef.current.on("connect", handleConnect);
    socketRef.current.on("disconnect", handleDisconnect);

    // 초기 상태 설정
    setConnectionStatus(socketRef.current.connected ? "connected" : "disconnected");

    return () => {
      socketRef.current.off("connect", handleConnect);
      socketRef.current.off("disconnect", handleDisconnect);
    };
  }, [
    currentUser,
    router.query.room,
    setupRoom,
    setConnected,
    isInitialized,
    setError,
  ]);

  // Rest of the component code...

  return {
    room,
    messages,
    streamingMessages,
    connected,
    currentUser,
    message,
    showEmojiPicker,
    showMentionList,
    mentionFilter,
    mentionIndex,
    filePreview,
    uploading,
    uploadProgress,
    uploadError,
    isNearBottom,
    hasMoreMessages,
    loadingMessages,
    error,
    loading,
    connectionStatus,
    messageLoadError,
    
    // Refs
    fileInputRef,
    messageInputRef,
    messagesEndRef,
    socketRef,

    // Handlers
    handleMessageChange,
    handleMessageSubmit,
    handleEmojiToggle,
    handleKeyDown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleMessageSubmit({ content: message, type: "text" });
      }
    },
    handleScroll,
    handleLoadMore,
    handleConnectionError,
    handleReconnect,
    getFilteredParticipants,
    insertMention,
    scrollToBottom,
    removeFilePreview,
    handleReactionAdd,
    handleReactionRemove,
    cleanup,

    // Setters
    setMessage,
    setShowEmojiPicker,
    setShowMentionList,
    setMentionFilter,
    setMentionIndex,
    setStreamingMessages,
    setError,

    // Retry handler
    retryMessageLoad: useCallback(() => {
      if (mountedRef.current) {
        messageLoadAttemptRef.current = 0;
        processedMessageIds.current.clear();
        loadInitialMessages(router.query.room);
      }
    }, [loadInitialMessages, router.query.room]),
  };
};

export default useChatRoom;