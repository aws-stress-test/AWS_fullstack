// frontend/services/axios.js
import axios from 'axios';
import authService from './authService';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_BASE_URL) {
  console.warn('Warning: NEXT_PUBLIC_API_URL is not defined in environment variables');
}

// 재시도 설정
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffFactor: 2,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  retryableErrors: ['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'ERR_NETWORK']
};

// 기본 설정으로 axios 인스턴스 생성
const axiosInstance = axios.create({
  baseURL: API_BASE_URL || 'http://localhost:5000',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

// 재시도 딜레이 계산 함수 
const getRetryDelay = (retryCount) => {
  // 지수 백오프와 약간의 무작위성 추가
  const delay = RETRY_CONFIG.initialDelayMs * 
    Math.pow(RETRY_CONFIG.backoffFactor, retryCount) *
    (1 + Math.random() * 0.1); // 지터 추가
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
};

// 재시도 가능한 에러인지 판단하는 함수
const isRetryableError = (error) => {
  if (!error) return false;
  
  // 네트워크 에러 코드 확인
  if (error.code && RETRY_CONFIG.retryableErrors.includes(error.code)) {
    return true;
  }
  
  // HTTP 상태 코드 확인
  if (error.response?.status && RETRY_CONFIG.retryableStatuses.includes(error.response.status)) {
    return true;
  }
  
  // 응답이 없는 경우 (네트워크 에러)
  if (!error.response && error.request) {
    return true;
  }
  
  return false;
};

// 요청 취소 토큰 저장소
const pendingRequests = new Map();

// 이전 요청 취소 함수
const cancelPendingRequests = (config) => {
  const requestKey = `${config.method}:${config.url}`;
  const previousRequest = pendingRequests.get(requestKey);
  
  if (previousRequest) {
    previousRequest.cancel('Request canceled due to duplicate request');
    pendingRequests.delete(requestKey);
  }
};

// 요청 인터셉터
axiosInstance.interceptors.request.use(
  async (config) => {
    try {
      // 요청 데이터 검증
      if (config.method !== 'get' && !config.data) {
        config.data = {};
      }

      // 인증 토큰 설정
      const user = authService.getCurrentUser();
      if (user?.token) {
        config.headers['x-auth-token'] = user.token;
        if (user.sessionId) {
          config.headers['x-session-id'] = user.sessionId;
        }
      }

      return config;
    } catch (error) {
      console.error('Request interceptor error:', error);
      return Promise.reject(error);
    }
  },
  (error) => Promise.reject(error)
);

// 응답 인터셉터
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response?.status;
    const errorData = error.response?.data;
    const errorMessage = errorData?.message || error.message;

    // 403 에러는 throw하지 않고 그대로 반환
    if (status === 403) {
      return Promise.reject(error.response);
    }

    // 401 에러 (토큰 만료)의 경우에만 토큰 갱신 처리
    if (status === 401 && errorData?.code === 'TOKEN_EXPIRED' && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const refreshed = await authService.refreshToken();
        if (refreshed) {
          originalRequest.headers['Authorization'] = `Bearer ${authService.getToken()}`;
          return axiosInstance(originalRequest);
        }
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError);
        authService.logout();
        window.location.href = '/?error=session_expired';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

// 인스턴스 내보내기
export default axiosInstance;