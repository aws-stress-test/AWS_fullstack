# Deploy
read -e -p "> Do you want to deploy (y/N)? " deploy
if [ "$deploy" = "y" ]
then
echo "> Deploy starts..."

aws s3 sync ./build s3://bw-cdn-s3 --exclude ".DS_Store" --profile ktb
aws cloudfront create-invalidation --distribution-id E1BTMTLQWFJU51 --paths "/*" --profile ktb
  
echo "> Deploy finished!"
echo ""
else
echo ""
fi