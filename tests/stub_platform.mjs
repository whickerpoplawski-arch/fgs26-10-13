/**
 * 假赛方提交接口 —— **必须跑在独立进程里**。
 *
 * 原因：插件用 `spawnSync` 执行 verifyCommand，会阻塞父进程的事件循环。
 * 如果 stub 服务器跑在同一个进程里，子进程发来的 HTTP 请求永远得不到响应，
 * 结果就是「真 flag 也被判拒」。所以 stub 必须是独立进程。
 *
 * 行为由 flag 内容决定（便于一个 stub 覆盖全部分支）：
 *   含 "dup" → 409（重复提交）；含 "bad" → 403（判错）；其它 → 200（判对）
 *
 * 启动后向 stdout 打印一行 `PORT <port>`，父测试据此拿地址。
 */
import http from 'node:http';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let flag = '';
    try {
      flag = String(JSON.parse(body)?.flag ?? '');
    } catch {
      /* 非法 JSON 按判错处理 */
    }
    let status = 200;
    if (flag.includes('dup')) status = 409;
    else if (flag.includes('bad')) status = 403;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ correct: status < 300, flag }));
  });
});

server.listen(Number(process.env.STUB_PORT || 0), '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`);
});
