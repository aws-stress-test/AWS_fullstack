#!/bin/bash

# AWS 프로파일 설정
export AWS_PROFILE=ktb

# 임시 파일들 생성
TMP_FILE=$(mktemp)
COUNTER_FILE=$(mktemp)

echo "[all]" > "$TMP_FILE"

# frontend와 backend 인스턴스 모두 조회
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress,PrivateIpAddress,Tags[?Key==`Name`].Value[],Tags[?Key==`service`].Value[]]' \
  --output json | jq -c '.[]' | while read -r instance; do
  
  INSTANCE_ID=$(echo "$instance" | jq -r '.[0]')
  PUBLIC_IP=$(echo "$instance" | jq -r '.[1]')
  PRIVATE_IP=$(echo "$instance" | jq -r '.[2]')
  NAME=$(echo "$instance" | jq -r '.[3][0]')
  SERVICE=$(echo "$instance" | jq -r '.[4][0]')
  
  # Name 태그가 없으면 인스턴스 ID 사용
  if [ "$NAME" = "null" ]; then
    NAME=$INSTANCE_ID
  fi
  
  # IP 주소 선택 (공개 IP가 없으면 사설 IP 사용)
  IP=$PUBLIC_IP
  if [ "$IP" = "null" ]; then
    IP=$PRIVATE_IP
  fi
  
  if [ "$SERVICE" = "frontend" ] || [ "$SERVICE" = "backend" ]; then
    # 이름 카운터 증가
    COUNT=$(grep -c "^$NAME:" "$COUNTER_FILE" || echo "0")
    COUNT=$((COUNT + 1))
    echo "$NAME:$COUNT" >> "$COUNTER_FILE"
    
    NUMBERED_NAME="${NAME}-${COUNT}"
    echo "$NUMBERED_NAME ansible_host=$IP private_ip=$PRIVATE_IP" >> "$TMP_FILE"
  fi
done

echo -e "\n[frontend]" >> "$TMP_FILE"

# counter 파일 초기화
> "$COUNTER_FILE"

# frontend 인스턴스 추가
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" "Name=tag:service,Values=frontend" \
  --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value[]]' \
  --output json | jq -c '.[]' | while read -r instance; do
  
  INSTANCE_ID=$(echo "$instance" | jq -r '.[0]')
  NAME=$(echo "$instance" | jq -r '.[1][0]')
  
  if [ "$NAME" = "null" ]; then
    NAME=$INSTANCE_ID
  fi
  
  COUNT=$(grep -c "^$NAME:" "$COUNTER_FILE" || echo "0")
  COUNT=$((COUNT + 1))
  echo "$NAME:$COUNT" >> "$COUNTER_FILE"
  
  NUMBERED_NAME="${NAME}-${COUNT}"
  echo "$NUMBERED_NAME" >> "$TMP_FILE"
done

echo -e "\n[backend]" >> "$TMP_FILE"

# counter 파일 초기화
> "$COUNTER_FILE"

# backend 인스턴스 추가
aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running" "Name=tag:service,Values=backend" \
  --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value[]]' \
  --output json | jq -c '.[]' | while read -r instance; do
  
  INSTANCE_ID=$(echo "$instance" | jq -r '.[0]')
  NAME=$(echo "$instance" | jq -r '.[1][0]')
  
  if [ "$NAME" = "null" ]; then
    NAME=$INSTANCE_ID
  fi
  
  COUNT=$(grep -c "^$NAME:" "$COUNTER_FILE" || echo "0")
  COUNT=$((COUNT + 1))
  echo "$NAME:$COUNT" >> "$COUNTER_FILE"
  
  NUMBERED_NAME="${NAME}-${COUNT}"
  echo "$NUMBERED_NAME" >> "$TMP_FILE"
done

# 결과 출력 후 임시 파일들 삭제
cat "$TMP_FILE"
rm "$TMP_FILE"
rm "$COUNTER_FILE"