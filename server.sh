#!/bin/bash

# 로그 및 환경 설정
LOG_FILE="/home/ubuntu/server-script.log"
exec > >(tee -a $LOG_FILE) 2>&1
PROJECT_ROOT="/home/ubuntu/AWS_fullstack"

# 상수 정의
FRONTEND=1
BACKEND=2

# 유틸리티 함수
log_error() {
    echo "❌ $1"
    exit 1
}

log_info() {
    echo "ℹ️ $1"
}

log_success() {
    echo "✅ $1"
}

# 서비스 관련 함수
get_service_info() {
    local service_num=$1
    if [ "$service_num" == "$FRONTEND" ]; then
        echo "frontend"
    else
        echo "backend"
    fi
}

set_working_dir() {
    local service_num=$1
    local service_name=$(get_service_info $service_num)
    
    cd $PROJECT_ROOT || log_error "프로젝트 루트 디렉토리 접근 실패"
    cd $service_name || log_error "${service_name} 디렉토리 접근 실패"
}

# Git 및 빌드 함수
handle_git_pull() {
    local service_num=$1
    local service_name=$(get_service_info $service_num)
    
    set_working_dir $service_num
    log_info "Git pull 실행 중: ${service_name}..."
    
    git pull origin main || log_error "Git pull 실패"
    log_success "Git pull 완료"
    
    # Frontend의 경우 pull 후 자동 빌드
    if [ "$service_num" == "$FRONTEND" ]; then
        handle_build
    fi
}

handle_build() {
    set_working_dir $FRONTEND
    log_info "Frontend 빌드 시작..."
    
    rm -rf .next
    npm run build || log_error "Frontend 빌드 실패"
    log_success "Frontend 빌드 완료"
}

# PM2 서비스 관리 함수
start_service() {
    local service_num=$1
    local service_name=$(get_service_info $service_num)
    set_working_dir $service_num
    
    if [ "$service_num" == "$FRONTEND" ] && [ ! -d ".next" ]; then
        log_info "빌드 폴더가 없습니다. 초기화 진행..."
        handle_git_pull $service_num
    fi
    
    log_info "${service_name} 시작 중..."
    pm2 start ecosystem.config.js --env prod || log_error "PM2 시작 실패"
    log_success "${service_name} 시작됨"
}

stop_service() {
    local service_num=$1
    local service_name=$(get_service_info $service_num)
    set_working_dir $service_num
    
    log_info "${service_name} 중지 중..."
    pm2 stop ecosystem.config.js || log_error "PM2 중지 실패"
    log_success "${service_name} 중지됨"
}

restart_service() {
    local service_num=$1
    local service_name=$(get_service_info $service_num)
    set_working_dir $service_num
    
    if [ "$service_num" == "$FRONTEND" ] && [ ! -d ".next" ]; then
        log_info "빌드 폴더가 없습니다. 초기화 진행..."
        handle_git_pull $service_num
    fi
    
    log_info "${service_name} 재시작 중..."
    pm2 restart ecosystem.config.js --env prod || log_error "PM2 재시작 실패"
    log_success "${service_name} 재시작 완료"
}

delete_service() {
    local service_num=$1
    local service_name=$(get_service_info $service_num)
    set_working_dir $service_num
    
    log_info "${service_name} 삭제 중..."
    pm2 delete ecosystem.config.js || log_error "PM2 삭제 실패"
    log_success "${service_name} 삭제됨"
}

# 메인 실행부
main() {
    local action=$1
    local service_num=$2
    local option=$3
    
    # 입력값 검증
    if [ -z "$action" ] || [ -z "$service_num" ]; then
        echo "사용법: $0 {start|stop|restart|delete} {1|2} [pull|build]"
        echo "  1: Frontend 서비스"
        echo "  2: Backend 서비스"
        echo "옵션:"
        echo "  pull: Git pull 실행 (frontend/backend)"
        echo "  build: Frontend 빌드 (frontend만)"
        exit 1
    fi
    
    if ! [[ "$service_num" =~ ^[1-2]$ ]]; then
        log_error "서비스 번호는 1(frontend) 또는 2(backend)여야 합니다."
    fi
    
    # 옵션 처리
    case $option in
        "pull")
            handle_git_pull $service_num
            ;;
        "build")
            if [ "$service_num" == "$FRONTEND" ]; then
                handle_build
            else
                log_error "빌드 옵션은 frontend에만 사용 가능합니다"
            fi
            ;;
    esac
    
    # 액션 처리
    case $action in
        "start")   start_service $service_num ;;
        "stop")    stop_service $service_num ;;
        "restart") restart_service $service_num ;;
        "delete")  delete_service $service_num ;;
        *)
            log_error "잘못된 액션입니다. {start|stop|restart|delete} 중 하나를 사용하세요."
            ;;
    esac
}

# 스크립트 실행
main "$@"
