import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  memo,
} from "react";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";
import { Card, FormControl } from "@goorm-dev/vapor-core";
import {
  Button,
  Status,
  Spinner,
  Text,
  Alert,
  Modal,
  Input,
} from "@goorm-dev/vapor-components";
import {
  HScrollTable,
  useHScrollTable,
  cellHelper,
} from "@goorm-dev/vapor-tables";
import { Lock, AlertCircle, WifiOff, RefreshCcw } from "lucide-react";
import socketService from "../services/socket";
import authService from "../services/authService";
import axiosInstance from "../services/axios";
import { withAuth } from "../middleware/withAuth";
import { Toast } from "../components/Toast";
import Image from "next/image";
import { useInView } from "react-intersection-observer";
import { debounce } from "lodash";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

const CONNECTION_STATUS = {
  CHECKING: "checking",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
};

const STATUS_CONFIG = {
  [CONNECTION_STATUS.CHECKING]: { label: "연결 확인 중...", color: "warning" },
  [CONNECTION_STATUS.CONNECTING]: { label: "연결 중...", color: "warning" },
  [CONNECTION_STATUS.CONNECTED]: { label: "연결됨", color: "success" },
  [CONNECTION_STATUS.DISCONNECTED]: { label: "연결 끊김", color: "danger" },
  [CONNECTION_STATUS.ERROR]: { label: "연결 오류", color: "danger" },
};

const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 5000,
  backoffFactor: 2,
  reconnectInterval: 30000,
};

const SCROLL_THRESHOLD = 50;
const SCROLL_DEBOUNCE_DELAY = 150;
const INITIAL_PAGE_SIZE = 10;

const SCROLL_CONFIG = {
  threshold: 0.5,
  triggerOnce: false,
};

const DEBOUNCE_CONFIG = {
  wait: 150,
  leading: true,
  trailing: true,
};

const LoadingIndicator = ({ text }) => (
  <div className="loading-indicator">
    <Spinner size="sm" className="mr-3" />
    <Text size="sm" color="secondary">
      {text}
    </Text>
  </div>
);

const TableWrapper = memo(
  ({ children, onScroll, loadingMore, hasMore, rooms }) => {
    const containerRef = useRef(null);
    const scrollTimeoutRef = useRef(null);
    
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const handleScroll = () => {
        if (scrollTimeoutRef.current) {
          window.cancelAnimationFrame(scrollTimeoutRef.current);
        }

        scrollTimeoutRef.current = window.requestAnimationFrame(() => {
          if (!hasMore || loadingMore) return;

          const { scrollTop, scrollHeight, clientHeight } = container;
          const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;
          
          if (scrollPercentage > 0.9) {
            onScroll();
          }
        });
      };

      container.addEventListener('scroll', handleScroll, { passive: true });

      return () => {
        if (scrollTimeoutRef.current) {
          window.cancelAnimationFrame(scrollTimeoutRef.current);
        }
        container.removeEventListener('scroll', handleScroll);
      };
    }, [hasMore, loadingMore, onScroll]);

    return (
      <div
        ref={containerRef}
        className="chat-rooms-table"
        style={{
          height: "430px",
          overflowY: "auto",
          position: "relative",
          borderRadius: "0.5rem",
          backgroundColor: "var(--background-normal)",
          border: "1px solid var(--border-color)",
          scrollBehavior: "smooth",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {children}
        {loadingMore && (
          <div className="flex items-center justify-center gap-2 p-4 border-t border-gray-700">
            <LoadingIndicator text="추가 채팅방을 불러오는 중..." />
          </div>
        )}
        {!hasMore && rooms?.length > 0 && (
          <div className="p-4 text-center border-t border-gray-700">
            <Text size="sm" color="secondary">
              모든 채팅방을 불러왔습니다.
            </Text>
          </div>
        )}
      </div>
    );
  }
);

function ChatRoomsComponent() {
  const router = useRouter();
  const [rooms, setRooms] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentUser] = useState(authService.getCurrentUser());
  const [connectionStatus, setConnectionStatus] = useState(
    CONNECTION_STATUS.CHECKING
  );
  const [retryCount, setRetryCount] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const [sorting, setSorting] = useState([{ id: "createdAt", desc: true }]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize] = useState(INITIAL_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(true);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Refs
  const socketRef = useRef(null);
  const tableContainerRef = useRef(null);
  const connectionCheckTimerRef = useRef(null);
  const isLoadingRef = useRef(false);
  const previousRoomsRef = useRef([]);
  const lastLoadedPageRef = useRef(0);
  const observerRef = useRef(null);

  const [passwordModal, setPasswordModal] = useState({
    isOpen: false,
    roomId: null,
    password: "",
    error: null,
  });

  const getRetryDelay = useCallback((retryCount) => {
    const delay =
      RETRY_CONFIG.baseDelay *
      Math.pow(RETRY_CONFIG.backoffFactor, retryCount) *
      (1 + Math.random() * 0.1);
    return Math.min(delay, RETRY_CONFIG.maxDelay);
  }, []);

  const handleAuthError = useCallback(
    async (error) => {
      try {
        if (
          error.response?.status === 401 ||
          error.response?.data?.code === "TOKEN_EXPIRED"
        ) {
          const refreshed = await authService.refreshToken();
          if (refreshed) {
            return true;
          }
        }
        authService.logout();
        router.replace("/?error=session_expired");
        return false;
      } catch (error) {
        console.error("Auth error handling failed:", error);
        authService.logout();
        router.replace("/?error=auth_error");
        return false;
      }
    },
    [router]
  );

  const handleFetchError = useCallback(
    (error, isLoadingMore) => {
      let errorMessage = "채팅방 목록을 불러오는데 실패했습니다.";
      let errorType = "danger";
      let showRetry = !isRetrying;

      if (error.message === "SERVER_UNREACHABLE") {
        errorMessage =
          "서버와 연결할 수 없습니다. 잠시 후 자동으로 재시도합니다.";
        errorType = "warning";
        showRetry = true;

        if (!isLoadingMore && retryCount < RETRY_CONFIG.maxRetries) {
          const delay = getRetryDelay(retryCount);
          setRetryCount((prev) => prev + 1);
          setTimeout(() => {
            setIsRetrying(true);
            fetchRooms(isLoadingMore);
          }, delay);
        }
      }

      if (!isLoadingMore) {
        setError({
          title: "채팅방 목록 로드 실패",
          message: errorMessage,
          type: errorType,
          showRetry,
        });
      }

      setConnectionStatus(CONNECTION_STATUS.ERROR);
    },
    [isRetrying, retryCount, getRetryDelay]
  );

  const attemptConnection = useCallback(
    async (retryAttempt = 0) => {
      try {
        setConnectionStatus(CONNECTION_STATUS.CONNECTING);

        const response = await axiosInstance.get("/health", {
          timeout: 5000,
          retries: 1,
        });

        const isConnected =
          response?.data?.status === "ok" && response?.status === 200;

        if (isConnected) {
          setConnectionStatus(CONNECTION_STATUS.CONNECTED);
          setRetryCount(0);
          return true;
        }

        throw new Error("Server not ready");
      } catch (error) {
        console.error(`Connection attempt ${retryAttempt + 1} failed:`, error);

        if (!error.response && retryAttempt < RETRY_CONFIG.maxRetries) {
          const delay = getRetryDelay(retryAttempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          return attemptConnection(retryAttempt + 1);
        }

        setConnectionStatus(CONNECTION_STATUS.ERROR);
        throw new Error("SERVER_UNREACHABLE");
      }
    },
    [getRetryDelay]
  );

  const fetchRooms = useCallback(
    debounce(async (isLoadingMore = false) => {
      if (!currentUser?.token || isLoadingRef.current) {
        return;
      }

      try {
        isLoadingRef.current = true;

        if (!isLoadingMore) {
          setLoading(true);
          setError(null);
        } else {
          setLoadingMore(true);
        }

        await attemptConnection();

        const response = await axiosInstance.get("/api/rooms", {
          params: {
            page: isLoadingMore ? pageIndex : 0,
            pageSize,
            sortField: sorting[0]?.id,
            sortOrder: sorting[0]?.desc ? "desc" : "asc",
          },
          headers: {
            "Cache-Control": "max-age=60",
          },
        });

        if (!response?.data?.data) {
          throw new Error("INVALID_RESPONSE");
        }

        const { data, metadata } = response.data;

        setRooms((prev) => {
          if (isLoadingMore) {
            const existingIds = new Set(prev.map((room) => room._id));
            const newRooms = data.filter((room) => !existingIds.has(room._id));
            return [...prev, ...newRooms];
          }
          return data;
        });

        setHasMore(data.length === pageSize && metadata.hasMore);

        if (isInitialLoad) {
          setIsInitialLoad(false);
        }
      } catch (error) {
        console.error("Rooms fetch error:", error);
        handleFetchError(error, isLoadingMore);
      } finally {
        if (!isLoadingMore) {
          setLoading(false);
        }
        setLoadingMore(false);
        isLoadingRef.current = false;
      }
    }, DEBOUNCE_CONFIG),
    [
      currentUser,
      pageIndex,
      pageSize,
      sorting,
      isInitialLoad,
      attemptConnection,
      handleFetchError,
    ]
  );

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore || isLoadingRef.current) {
      console.log("Load more prevented:", {
        loadingMore,
        hasMore,
        isLoading: isLoadingRef.current,
      });
      return;
    }

    try {
      console.log("Loading more rooms...");
      setLoadingMore(true);
      isLoadingRef.current = true;

      const nextPage = Math.floor(rooms.length / pageSize);
      console.log("Loading page:", nextPage);
      setPageIndex(nextPage);
      await fetchRooms(true);

      // const response = await axiosInstance.get("/api/rooms", {
      //   params: {
      //     page: nextPage,
      //     pageSize,
      //     sortField: sorting[0]?.id,
      //     sortOrder: sorting[0]?.desc ? "desc" : "asc",
      //   },
      // });

      // if (response.data?.success) {
      //   const { data: newRooms, metadata } = response.data;
      //   console.log("Loaded new rooms:", {
      //     count: newRooms.length,
      //     hasMore: metadata.hasMore,
      //   });

      //   setRooms((prev) => {
      //     const existingIds = new Set(prev.map((room) => room._id));
      //     const uniqueNewRooms = newRooms.filter(
      //       (room) => !existingIds.has(room._id)
      //     );
      //     console.log("Unique new rooms:", uniqueNewRooms.length);
      //     return [...prev, ...uniqueNewRooms];
      //   });

      //   setHasMore(newRooms.length === pageSize && metadata.hasMore);
      // }
    } catch (error) {
      console.error("Load more rooms error:", error);
      handleFetchError(error, true);
    } finally {
      setLoadingMore(false);
      isLoadingRef.current = false;
      Toast.info("추가 채팅방을 불러왔습니다.");
    }
  //}, [loadingMore, hasMore, rooms.length, pageSize, sorting, handleFetchError]);
  }, [loadingMore, hasMore, rooms.length, pageSize, fetchRooms]);

  // 페이지 인덱스 변경 시 데이터 로드
  useEffect(() => {
    if (pageIndex > 0) {
      fetchRooms(true);
    }
  }, [pageIndex, fetchRooms]);

  // 초기 로드
  useEffect(() => {
    if (!currentUser) return;
  
    let isFirstLoad = true;  // 초기 로드 체크용 플래그
  
    const initFetch = async () => {
      try {
        await fetchRooms(false);
        setConnectionStatus(CONNECTION_STATUS.CONNECTED);
      } catch (error) {
        console.error("Initial fetch failed:", error);
        setConnectionStatus(CONNECTION_STATUS.ERROR);
        
        // 초기 로드 실패 시에만 한 번 재시도
        if (isFirstLoad) {
          isFirstLoad = false;
          setTimeout(() => {
            fetchRooms(false);
          }, 3000);
        }
      }
    };
  
    // 최초 로드 시 한 번만 실행
    initFetch();
  
    // 연결 상태 모니터링 (연결이 끊어졌을 때만)
    connectionCheckTimerRef.current = setInterval(() => {
      if (connectionStatus === CONNECTION_STATUS.DISCONNECTED) {
        attemptConnection();
      }
    }, 10000);  
  
    return () => {
      if (connectionCheckTimerRef.current) {
        clearInterval(connectionCheckTimerRef.current);
      }
    };
  }, [currentUser]); 

  useEffect(() => {
    const handleOnline = () => {
      console.log("Network is online");
      setConnectionStatus(CONNECTION_STATUS.CONNECTING);
      lastLoadedPageRef.current = 0;
      setPageIndex(0);
      fetchRooms(false);
    };

    const handleOffline = () => {
      console.log("Network is offline");
      setConnectionStatus(CONNECTION_STATUS.DISCONNECTED);
      setError({
        title: "네트워크 연결 끊김",
        message: "인터넷 연결을 확인해주세요.",
        type: "danger",
      });
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [fetchRooms]);

  useEffect(() => {
    if (!currentUser?.token) return;

    let isSubscribed = true;

    const connectSocket = async () => {
      try {
        const socket = await socketService.connect({
          auth: {
            token: currentUser.token,
            sessionId: currentUser.sessionId,
          },
        });

        if (!isSubscribed || !socket) return;

        socketRef.current = socket;

        const handlers = {
          connect: () => {
            setConnectionStatus(CONNECTION_STATUS.CONNECTED);
            socket.emit("joinRoomList");
          },
          disconnect: (reason) => {
            setConnectionStatus(CONNECTION_STATUS.DISCONNECTED);
            console.log("Socket disconnected:", reason);
          },
          error: (error) => {
            console.error("Socket error:", error);
            setConnectionStatus(CONNECTION_STATUS.ERROR);
          },
          roomCreated: (newRoom) => {
            setRooms((prev) => {
              const updatedRooms = [newRoom, ...prev];
              previousRoomsRef.current = updatedRooms;
              return updatedRooms;
            });
          },
          roomDeleted: (roomId) => {
            setRooms((prev) => {
              const updatedRooms = prev.filter((room) => room._id !== roomId);
              previousRoomsRef.current = updatedRooms;
              return updatedRooms;
            });
          },
          roomUpdated: (updatedRoom) => {
            setRooms((prev) => {
              const updatedRooms = prev.map((room) =>
                room._id === updatedRoom._id ? updatedRoom : room
              );
              previousRoomsRef.current = updatedRooms;
              return updatedRooms;
            });
          },
        };

        Object.entries(handlers).forEach(([event, handler]) => {
          socket.on(event, handler);
        });
      } catch (error) {
        console.error("Socket connection error:", error);
        if (!isSubscribed) return;

        if (
          error.message?.includes("Authentication required") ||
          error.message?.includes("Invalid session")
        ) {
          handleAuthError({ response: { status: 401 } });
        }

        setConnectionStatus(CONNECTION_STATUS.ERROR);
      }
    };

    connectSocket();

    return () => {
      isSubscribed = false;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [currentUser, handleAuthError]);

  const handleJoinRoom = async (roomId, hasPassword) => {
    if (connectionStatus !== CONNECTION_STATUS.CONNECTED) {
      setError({
        title: "채팅방 입장 실패",
        message: "서버와 연결이 끊어져 있습니다.",
        type: "danger",
      });
      return;
    }

    // 비밀번호가 필요한 방인 경우
    if (hasPassword) {
      setPasswordModal({
        isOpen: true,
        roomId,
        password: "",
        error: null,
      });
      return;
    }

    // 비밀번호가 없는 방인 경우 바로 입장 시도
    try {
      const response = await axiosInstance.post(
        `/api/rooms/${roomId}/join`,
        {},
        {
          timeout: 5000,
        }
      );

      if (response.data.success) {
        router.push(`/chat?room=${roomId}`);
      }
    } catch (error) {
      console.error("Room join error:", error);

      let errorMessage = "입장에 실패했습니다.";
      if (error.response?.status === 404) {
        errorMessage = "채팅방을 찾을 수 없습니다.";
      } else if (error.response?.status === 401) {
        errorMessage = "비밀번호가 일치하지 않습니다.";
      } else if (error.response?.status === 403) {
        errorMessage = "채팅방 입장 권한이 없습니다.";
      }

      setError({
        title: "채팅방 입장 실패",
        message: error.response?.data?.message || errorMessage,
        type: "danger",
      });
    }
  };

  const handlePasswordSubmit = async () => {
    try {
      const response = await axiosInstance.post(
        `/api/rooms/${passwordModal.roomId}/join`,
        {
          password: passwordModal.password,
        },
        {
          timeout: 5000,
        }
      );

      if (response.data.success) {
        setPasswordModal((prev) => ({ ...prev, isOpen: false }));
        router.push(`/chat?room=${passwordModal.roomId}`);
      }
    } catch (error) {
      console.error("Room join with password error:", error);

      // 비밀번호가 틀린 경우 (403 에러)
      if (error.response?.status === 403) {
        setPasswordModal((prev) => ({
          ...prev,
          error: "채팅방 비밀번호가 올바르지 않습니다. 다시 입력해주세요.",
          password: "",
        }));

        const passwordInput = document.querySelector('input[type="password"]');
        if (passwordInput) {
          passwordInput.focus();
        }
        return;
      }

      // 기타 에러
      setPasswordModal((prev) => ({
        ...prev,
        error: "채팅방 입장에 실패했습니다. 다시 시도해주세요.",
        password: "",
      }));
    }
  };

  const columns = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "채팅방",
        cell: cellHelper(({ value, rowData }) => (
          <div className="d-flex align-items-center gap-2">
            <Text className="font-medium">{value}</Text>
            {rowData.hasPassword && (
              <Lock size={14} className="text-gray-500" />
            )}
          </div>
        )),
        size: 200,
        enableSorting: true,
      },
      {
        accessorKey: "participants",
        header: "참여자",
        cell: cellHelper(({ value }) => (
          <Text className="participants-count">{value?.length || 0}명</Text>
        )),
        size: 100,
        enableSorting: true,
      },
      {
        accessorKey: "createdAt",
        header: "생성일",
        cell: cellHelper(({ value }) => (
          <Text className="created-at">
            {new Date(value).toLocaleString("ko-KR", {
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        )),
        size: 200,
        enableSorting: true,
        sortingFn: "datetime",
      },
      {
        accessorKey: "actions",
        header: "",
        cell: cellHelper(({ rowData }) => (
          <Button
            variant="primary"
            size="md"
            onClick={() => handleJoinRoom(rowData._id, rowData.hasPassword)}
            disabled={connectionStatus !== CONNECTION_STATUS.CONNECTED}
          >
            입장
          </Button>
        )),
        size: 100,
        enableSorting: false,
      },
    ],
    [connectionStatus]
  );

  const memoizedColumns = useMemo(() => columns, [connectionStatus]);
  const memoizedRooms = useMemo(() => rooms, [rooms]);

  const tableInstance = useHScrollTable({
    data: memoizedRooms,
    columns: memoizedColumns,
    extraColumnType: "index",
    useResizeColumn: true,
    sorting,
    setSorting,
    initialSorting: sorting,
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      import("web-vitals").then(({ getCLS, getFID, getLCP }) => {
        getCLS(console.log);
        getFID(console.log);
        getLCP(console.log);
      });
    }
  }, []);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          handleLoadMore();
        }
      },
      { threshold: 0.5 }
    );

    return () => observerRef.current?.disconnect();
  }, [hasMore, loadingMore, handleLoadMore]);

  return (
    <div className="chat-container">
      <Card className="chat-rooms-card">
        <Card.Header>
          <div className="flex justify-between items-center">
            <Card.Title>채팅방 목록</Card.Title>
            <div className="flex items-center gap-2">
              <Status
                label={STATUS_CONFIG[connectionStatus].label}
                color={STATUS_CONFIG[connectionStatus].color}
              />
              {(error || connectionStatus === CONNECTION_STATUS.ERROR) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    lastLoadedPageRef.current = 0;
                    setPageIndex(0);
                    fetchRooms(false);
                  }}
                  disabled={isRetrying}
                  className="ml-2"
                >
                  <RefreshCcw className="w-4 h-4" />
                  재연결
                </Button>
              )}
            </div>
          </div>
        </Card.Header>

        <Card.Body className="p-6">
          {error && (
            <Alert color={error.type} className="mb-4">
              <div className="flex items-start gap-2">
                {connectionStatus === CONNECTION_STATUS.ERROR ? (
                  <WifiOff className="w-4 h-4 mt-1" />
                ) : (
                  <AlertCircle className="w-4 h-4 mt-1" />
                )}
                <div>
                  <div className="font-medium">{error.title}</div>
                  <div className="mt-1">{error.message}</div>
                  {error.showRetry && !isRetrying && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        lastLoadedPageRef.current = 0;
                        setPageIndex(0);
                        fetchRooms(false);
                      }}
                      className="mt-2"
                    >
                      다시 시도
                    </Button>
                  )}
                </div>
              </div>
            </Alert>
          )}

          {loading ? (
            <LoadingIndicator text="채팅방 목록을 불러오는 중..." />
          ) : rooms.length > 0 ? (
            <TableWrapper
              onScroll={handleLoadMore}
              loadingMore={loadingMore}
              hasMore={hasMore}
              rooms={rooms}
            >
              <HScrollTable {...tableInstance.getTableProps()} />
            </TableWrapper>
          ) : (
            !error && (
              <div className="chat-rooms-empty">
                <Text className="mb-4">생성된 채팅방이 없습니다.</Text>
                <Button
                  variant="primary"
                  onClick={() => router.push("/chat-rooms/new")}
                  disabled={connectionStatus !== CONNECTION_STATUS.CONNECTED}
                >
                  새 채팅방 만들기
                </Button>
              </div>
            )
          )}
        </Card.Body>
      </Card>

      <Modal
        isOpen={passwordModal.isOpen}
        onClose={() =>
          setPasswordModal((prev) => ({
            ...prev,
            isOpen: false,
            error: null,
            password: "",
          }))
        }
      >
        <div className="modal-header">비밀번호 입력</div>
        <div className="modal-body">
          <div className="space-y-4">
            <Text>이 채팅방은 비밀번호가 필요합니다.</Text>
            <div className="space-y-2">
              <Input
                type="password"
                placeholder="비밀번호를 입력하세요"
                value={passwordModal.password}
                onChange={(e) =>
                  setPasswordModal((prev) => ({
                    ...prev,
                    password: e.target.value,
                    error: null,
                  }))
                }
                className={passwordModal.error ? "border-red-500" : ""}
              />
              {passwordModal.error && (
                <Text size="sm" color="danger">
                  {passwordModal.error}
                </Text>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <Button
            variant="ghost"
            onClick={() =>
              setPasswordModal((prev) => ({
                ...prev,
                isOpen: false,
                error: null,
                password: "",
              }))
            }
          >
            취소
          </Button>
          <Button
            variant="primary"
            onClick={handlePasswordSubmit}
            disabled={!passwordModal.password}
          >
            입장
          </Button>
        </div>
      </Modal>
    </div>
  );
}

const ChatRooms = dynamic(() => Promise.resolve(ChatRoomsComponent), {
  ssr: false,
  loading: () => (
    <div className="auth-container">
      <Card className="chat-rooms-card">
        <Card.Body className="p-6">
          <LoadingIndicator text="로딩 중..." />
        </Card.Body>
      </Card>
    </div>
  ),
});

export default withAuth(ChatRooms);
