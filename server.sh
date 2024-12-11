#!/bin/bash

# 로그 설정
LOG_FILE="/home/ubuntu/server-script.log"
exec > >(tee -a $LOG_FILE) 2>&1

# 환경 변수 설정
PROJECT_ROOT="/home/ubuntu/AWS_fullstack"

# 함수: 서비스 디렉토리 설정
set_service_dir() {
    local service_num=$1
    
    cd $PROJECT_ROOT || {
        echo "❌ 프로젝트 루트 디렉토리 접근 실패"
        exit 1
    }
    
    if [ "$service_num" == "1" ]; then
        cd frontend || {
            echo "❌ Frontend 디렉토리 접근 실패"
            exit 1
        }
    else
        cd backend || {
            echo "❌ Backend 디렉토리 접근 실패"
            exit 1
        }
    fi
}

# 함수: 서비스 이름 가져오기
get_service_name() {
    local service_num=$1
    if [ "$service_num" == "1" ]; then
        echo "frontend"
    else
        echo "backend"
    fi
}

# 함수: 초기화
initialize() {
    local service_num=$1
    local init=$2
    local service_name=$(get_service_name $service_num)
    
    set_service_dir $service_num
    
    if [ "$init" == "true" ]; then
        echo "🔄 Pulling latest code..."
        git pull origin main || {
            echo "❌ Git pull 실패"
            exit 1
        }
        
        echo "📦 Installing dependencies..."
        npm install || {
            echo "❌ npm install 실패"
            exit 1
        }
        
        # 프론트엔드일 경우에만 빌드 실행
        if [ "$service_num" == "1" ]; then
            echo "🏗️ Building frontend..."
            # 기존 빌드 폴더 삭제
            rm -rf build
            
            # 빌드 실행 및 에러 체크
            npm run build || {
                echo "❌ Frontend 빌드 실패"
                exit 1
            }
            
            echo "✅ Frontend 빌드 완료"
        fi
        
        echo "✅ $service_name 초기화 완료"
    fi
}

# 함수: 서비스 시작
start_service() {
    local service_num=$1
    local init=${2:-false}
    local service_name=$(get_service_name $service_num)
    
    echo "🚀 Starting $service_name service..."
    initialize $service_num $init
    
    if [ "$service_num" == "1" ]; then
        # 프론트���드의 경우 빌드 폴더 존재 확인
        if [ ! -d "build" ]; then
            echo "⚠️ Build 폴더가 없습니다. 초기화를 진행합니다..."
            initialize $service_num true
        fi
    fi
    
    pm2 start ecosystem.config.js --env prod || {
        echo "❌ PM2 시작 실패"
        exit 1
    }
    echo "✅ $service_name 서비스 시작됨"
}

# 함수: 서비스 중지
stop_service() {
    local service_num=$1
    local service_name=$(get_service_name $service_num)
    
    echo "🛑 Stopping $service_name service..."
    set_service_dir $service_num
    
    pm2 stop ecosystem.config.js || {
        echo "❌ PM2 중지 실패"
        exit 1
    }
    echo "🔴 $service_name 서비스 중지됨"
}

# 함수: 서비스 재시작
restart_service() {
    local service_num=$1
    local service_name=$(get_service_name $service_num)
    
    echo "🔄 Restarting $service_name service..."
    set_service_dir $service_num
    
    if [ "$service_num" == "1" ]; then
        # 프론트엔드의 경우 빌드 폴더 존재 확인
        if [ ! -d "build" ]; then
            echo "⚠️ Build 폴더가 없습니다. 초기화를 진행합니다..."
            initialize $service_num true
        fi
    fi
    
    pm2 restart ecosystem.config.js --env prod || {
        echo "❌ PM2 재시작 실패"
        exit 1
    }
    echo "✅ $service_name 서비스 재시작 완료"
}

# 함수: 서비스 상태 확인
check_status() {
    local service_num=$1
    local service_name=$(get_service_name $service_num)
    
    echo "👀 Checking $service_name service status..."
    set_service_dir $service_num
    
    pm2 status
}

# 메인 실행부
main() {
    local action=$1
    local service_num=$2
    local init=${3:-false}
    
    # 필수 인자 체크
    if [ -z "$action" ] || [ -z "$service_num" ]; then
        echo "Error: 필수 인자가 누락되었습니다."
        echo "사용법: $0 {start|stop|restart|status} {1|2} [init:true|false]"
        echo "  1: Frontend 서비스"
        echo "  2: Backend 서비스"
        exit 1
    fi
    
    # 입력값 검증
    if ! [[ "$service_num" =~ ^[1-2]$ ]]; then
        echo "Error: 서비스 번호는 1(frontend) 또는 2(backend)여야 합니다."
        echo "사용법: $0 {start|stop|restart|status} {1|2} [init:true|false]"
        echo "  1: Frontend 서비스"
        echo "  2: Backend 서비스"
        exit 1
    fi
    
    case $action in
        start)
            start_service $service_num $init
            ;;
        stop)
            stop_service $service_num
            ;;
        restart)
            restart_service $service_num
            ;;
        status)
            check_status $service_num
            ;;
        *)
            echo "사용법: $0 {start|stop|restart|status} {1|2} [init:true|false]"
            echo "  1: Frontend 서비스"
            echo "  2: Backend 서비스"
            exit 1
            ;;
    esac
}

# 스크립트 실행
main "$@"
