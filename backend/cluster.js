const cluster = require('cluster');
const os = require('os');
const http = require('http');
const { app } = require('./server');

cluster.schedulingPolicy = cluster.SCHED_RR; // Round-Robin 스케줄링

if (cluster.isPrimary) {
  const numCPUs = 2;
  
  // 워커 생성 전 메모리 할당
  const workerHeapSize = Math.floor((os.totalmem() * 0.7) / numCPUs);
  
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      NODE_OPTIONS: `--max-old-space-size=${workerHeapSize}`
    });
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`[마스터] 워커 ${worker.process.pid} 종료됨`);
    // 워커 재시작 전에 잠시 대기
    setTimeout(() => cluster.fork(), 1000);
  });

  // 단일 포트에서 서버를 실행
  const PORT = process.env.PORT || 5000;
  const server = http.createServer(app);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });

  // 예외 처리
  process.on('uncaughtException', (err) => {
    console.error('예기치 않은 에러:', err);
    process.exit(1);
  });

  // 워커 상태 모니터링
  setInterval(() => {
    const workers = Object.values(cluster.workers);
    const memoryUsage = process.memoryUsage();
    const cpuUsage = os.loadavg()[0];
    
    console.log('시스템 상태:', {
      activeWorkers: workers.length,
      workersInfo: workers.map(w => ({
        pid: w.process.pid,
        state: w.state
      })),
      memory: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
      cpu: `${(cpuUsage * 100).toFixed(1)}%`,
      uptime: process.uptime()
    });

    // CPU 사용률이 높으면 경고
    if (cpuUsage > 0.8) {
      console.warn('CPU 사용률 높음:', cpuUsage);
    }
  }, 30000);

} else {
  require('./server');
}
