#!/bin/bash

SERVERS=(
    "ip-10-0-11-221"
    "ip-10-0-2-139"
)
KEY="/home/ubuntu/.ssh/bw-key.pem"
DEPLOY_DIR="/home/ubuntu/release"

# 1. 빌드
echo "> Building Next.js project..."
npm run build
if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

# 2. AWS S3 배포 확인
read -e -p "> Do you want to deploy (y/N)? " deploy
if [ "$deploy" = "y" ]; then
    echo "> Deploy starts..."
    
    # AWS 프로파일 존재 여부 확인 및 설정
    if aws configure list-profiles 2>/dev/null | grep -q "^ktb$"; then
        AWS_PROFILE="--profile ktb"
    else
        AWS_PROFILE=""
    fi
    
    # .next/static 폴더를 _next/static 경로로 동기화
    aws s3 sync .next/static s3://bw-cdn-s3/_next/static --exclude ".DS_Store" $AWS_PROFILE
    aws cloudfront create-invalidation --distribution-id E1BTMTLQWFJU51 --paths "/*" $AWS_PROFILE
    
    echo "> Deploy finished!"
fi

# 3. 서버 배포
for SERVER in "${SERVERS[@]}"
do
    echo "> Deploying to ${SERVER}..."
    
    # 헬스체크
    echo "> Checking health status..."
    curl -s localhost:3000/health > /dev/null
    if [ $? -ne 0 ]; then
        echo "Health check failed!"
        exit 1
    fi
    
    # 파일 동기화
    echo "> Syncing files..."
    ssh -i $KEY ubuntu@${SERVER} "mkdir -p ${DEPLOY_DIR}"
    
    # Next.js 필요 파일들 복사
    rsync -avz --delete -e "ssh -i $KEY" .next/standalone/* ubuntu@${SERVER}:${DEPLOY_DIR}/
    rsync -avz -e "ssh -i $KEY" .next ubuntu@${SERVER}:${DEPLOY_DIR}/
    rsync -avz -e "ssh -i $KEY" public ubuntu@${SERVER}:${DEPLOY_DIR}/
    rsync -avz -e "ssh -i $KEY" ecosystem.config.js ubuntu@${SERVER}:${DEPLOY_DIR}/
    
    # PM2 재시작
    echo "> Restarting PM2..."
    ssh -i $KEY ubuntu@${SERVER} "cd ${DEPLOY_DIR} && pm2 reload ecosystem.config.js"
    
    echo "> Deployment completed for ${SERVER}"
done