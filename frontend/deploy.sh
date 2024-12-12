# Deploy
read -e -p "> Do you want to deploy (y/N)? " deploy
if [ "$deploy" = "y" ]
then
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
echo ""
else
echo ""
fi
