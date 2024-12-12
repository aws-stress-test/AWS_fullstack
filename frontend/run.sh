#!/bin/bash
source ../utils.sh

# Git 및 빌드 함수
handle_git_pull() {
    set_working_dir "frontend"
    log_info "Git pull 실행 중: frontend..."
    git pull origin main || log_error "Git pull 실패"
    log_success "Git pull 완료"
    handle_build
}

handle_build() {
    set_working_dir "frontend"
    log_info "Frontend 빌드 시작..."
    rm -rf .next
    npm run build || log_error "Frontend 빌드 실패"
    log_success "Frontend 빌드 완료"
}

start_service() {
    set_working_dir "frontend"
    if [ ! -d ".next" ]; then
        log_info "빌드 폴더가 없습니다. 초기화 진행..."
        handle_git_pull
    fi
    
    log_info "frontend 시작 중..."
    pm2 start ecosystem.config.js --env prod || log_error "PM2 시작 실패"
    log_success "frontend 시작됨"
}

stop_service() {
    set_working_dir "frontend"
    log_info "frontend 중지 중..."
    pm2 stop ecosystem.config.js || log_error "PM2 중지 실패"
    log_success "frontend 중지됨"
}

restart_service() {
    set_working_dir "frontend"
    if [ ! -d ".next" ]; then
        log_info "빌드 폴더가 없습니다. 초기화 진행..."
        handle_git_pull
    fi
    
    log_info "frontend 재시작 중..."
    pm2 restart ecosystem.config.js --env prod || log_error "PM2 재시작 실패"
    log_success "frontend 재시작 완료"
}

delete_service() {
    set_working_dir "frontend"
    log_info "frontend 삭제 중..."
    pm2 delete ecosystem.config.js || log_error "PM2 삭제 실패"
    log_success "frontend 삭제됨"
}

main() {
    local action=$1
    local option=$2
    
    if [ -z "$action" ]; then
        echo "사용법: $0 {start|stop|restart|delete} [pull|build]"
        echo "옵션:"
        echo "  pull: Git pull 실행"
        echo "  build: Frontend 빌드"
        exit 1
    fi
    
    case $option in
        "pull") handle_git_pull ;;
        "build") handle_build ;;
    esac
    
    case $action in
        "start")   start_service ;;
        "stop")    stop_service ;;
        "restart") restart_service ;;
        "delete")  delete_service ;;
        *)
            log_error "잘못된 액션입니다. {start|stop|restart|delete} 중 하나를 사용하세요."
            ;;
    esac
}

main "$@" 