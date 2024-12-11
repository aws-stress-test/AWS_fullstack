#!/bin/bash

# 로그 및 환경 설정
LOG_FILE="/home/ubuntu/server-script.log"
exec > >(tee -a $LOG_FILE) 2>&1
PROJECT_ROOT="/home/ubuntu/AWS_fullstack"

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

set_working_dir() {
    local service_name=$1
    cd $PROJECT_ROOT || log_error "프로젝트 루트 디렉토리 접근 실패"
    cd $service_name || log_error "${service_name} 디렉토리 접근 실패"
} 