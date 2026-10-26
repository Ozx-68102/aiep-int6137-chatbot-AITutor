# Findings

记实际看过、但文档或接口说明里不明显的行为。新的发现按日期追加在下面，不要把密钥、密码或 cookie 写进来。

## 2026-10-26 FastGPT 删除不存在的会话仍返回 200

访问地址本身以 `/api` 结尾。删除一场会话的上游地址是：

`DELETE {访问地址}/core/chat/history/delHistory?chatId={会话id}&appId={应用id}`

用一个从未说过话、上游没有记录的会话 id 调用，HTTP 状态仍是 200，正文是：

```json
{"code": 200, "statusText": "", "message": "", "data": null}
```

所以「这场会话在 FastGPT 里不存在」和「删除成功」看起来一样。我们的 `DELETE /api/sessions/{会话id}` 收到这个结果后，仍然删除自己数据库里的会话，并清掉 Redis 里的半截文字。上游返回 404 时同样删除本地。只有上游返回其他错误时，本地会话才保留。
