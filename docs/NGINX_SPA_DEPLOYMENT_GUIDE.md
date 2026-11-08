# Nginx 部署指南：H² Bot 前端的 SPA 回落

这份文档写给第一次把这个前端放上服务器的人，不预设你懂 Nginx 或前端框架。跟着做完，你会得到一个能正常刷新、能流式聊天的部署。

## 先弄明白要解决的问题

`pnpm build` 的产物 `dist/` 是一堆纯静态文件：一个 `index.html`，加上 `assets/` 目录里带哈希文件名的 JS 和 CSS。服务器不需要运行任何 Node 进程就能把它们发出去。

但本项目的页面用**真实路径路由**：会话页在 `/chat/<会话id>`，自助改密页在 `/change-pwd`，强制改密页在 `/force-change-pwd`，管理员控制台在 `/admin`，登录入口在 `/login`。这些路径在 `dist/` 里**没有对应的文件**——磁盘上只有 `index.html` 一个页面，"现在该显示哪个页"是由浏览器里的 JS 读地址决定的。

于是有了核心问题：用户在 `/chat/abc123` 上按刷新，浏览器会向服务器发 `GET /chat/abc123`。服务器在磁盘上找不到这个文件，默认就回 404。解决办法叫 **SPA 回落**（SPA fallback）：告诉服务器"任何找不到的路径，都把 `index.html` 发回去"，让浏览器里的 JS 接管剩下的事。

> 开发环境不用你操心这些：`pnpm run dev:frontend` 的 Vite 开发服务器和 `pnpm preview` 都内置了回落。这份文档只管正式部署。

## 准备

1. 一台 Linux 服务器，装好 Nginx（Debian/Ubuntu：`apt install nginx`；CentOS 系：`yum install nginx`）。
2. 在仓库根目录 `pnpm build`，把整个 `dist/` 的内容拷到服务器，例如 `/var/www/h2bot/dist`。
3. 接口服务（`server/`，见 README 的启动方式）跑在同一台机器的 `127.0.0.1:3001`。前端只发 `/api/...` 的相对路径请求，靠 Nginx 转发过去。

## 完整配置

Debian/Ubuntu 存成 `/etc/nginx/sites-available/h2bot.conf`（再软链到 `sites-enabled/`）；Centos 系存成 `/etc/nginx/conf.d/h2bot.conf`：

```nginx
server {
    listen 80;
    server_name h2bot.example.com;   # 换成你的域名或服务器 IP

    root /var/www/h2bot/dist;        # dist/ 内容所在的目录

    # ① SPA 回落：本文档的核心。
    #    先找真实文件（$uri）、再找目录（$uri/），都没有就返回 index.html，
    #    让浏览器里的前端路由自己认领 /chat/xxx、/change-pwd 这些地址。
    location / {
        try_files $uri $uri/ /index.html;
    }

    # ② index.html 永远不缓存：它记录着 JS/CSS 的文件名清单，
    #    发新版后文件名会变，浏览器必须每次都拿到新的这份。
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # ③ assets/ 下的文件名带内容哈希（内容一变文件名就变），
    #    可以放心缓存一年。
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # ④ 接口反向代理到本机的接口服务。
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 聊天走 SSE 流。缓冲必须关：否则 Nginx 会把先到的帧憋在手里，
        # 浏览器在流结束前一个字节都收不到，长静默也更容易碰到超时。
        # 注意：「静默几秒后回答整块出现」是上游的正常行为（它把答案
        # 全部写完才发，见 docs/FASTGPT_API.md「流式行为」），不是这行的锅。
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

匹配顺序不用担心：`location = /index.html` 是精确匹配、优先级最高；`/api/` 和 `/assets/` 是更长的前缀匹配，排在 `location /` 前面生效；其余全部落到 ①。①回落到 `/index.html` 时会重新走一遍匹配，正好命中②拿到不缓存的响应头。

## 部署步骤

```bash
sudo mkdir -p /var/www/h2bot
sudo cp -r dist /var/www/h2bot/           # 在本地构建好后拷上去，或直接在服务器上构建
sudo nano /etc/nginx/sites-available/h2bot.conf   # 粘贴上面的配置，改掉域名和路径
sudo ln -s /etc/nginx/sites-available/h2bot.conf /etc/nginx/sites-enabled/
sudo nginx -t                             # 测试配置语法，必须显示 ok / successful
sudo systemctl reload nginx
```

以后每次发新版前端：重新 `pnpm build`，用新的 `dist/` 覆盖 `/var/www/h2bot/dist`，不需要重启 Nginx（②③的缓存策略会让浏览器自己拿到新文件）。

## 验证清单

```bash
# 回落生效：随便编一个不存在的路径，应该返回 200 和 text/html，而不是 404
curl -I http://你的域名/chat/does-not-exist

# 接口反向代理生效：应该拿到后端返回的 JSON，而不是 Nginx 的 404 页
curl http://你的域名/api/status
```

再到浏览器里过一遍：打开首页 → 登录 → 点开一个会话（地址变成 `/chat/<id>`）→ **按刷新** → 页面还在原会话上 → 发一条要答几秒的消息（比如「写一篇 200 字的短文」）：先静默一阵，然后**回答整块出现——这是上游 FastGPT 的正常行为**（它把答案全部写完才发，见 [FASTGPT_API.md](FASTGPT_API.md)「流式行为」），不是 ④ 的缓冲没关。要确认缓冲真的关了：等回答的那段时间里，在开发者工具 Network 面板点开这条 `/api/chat` 请求，请求还没结束时 Response 里就应该已经有内容；直到请求整个结束才见到第一个字节的，才是缓冲没关。

## 常见故障对照

| 现象                              | 原因                          | 处理                                                           |
|-----------------------------------|-------------------------------|----------------------------------------------------------------|
| 刷新 `/chat/xxx`、`/admin` 就 404 | 没配 SPA 回落                 | 补上①                                                          |
| 页面白屏，控制台报 JS/CSS 404     | `root` 指错目录               | 确认 `index.html` 和 `assets/` 就在 `root` 下面一层            |
| 页面正常但登录报网络错误          | `/api` 没配反向代理，或接口服务没启动 | 查④，确认 3001 端口有进程在监听                                  |
| 静默几秒后回答整块出现              | 正常行为，不是故障               | 上游把答案全部写完才发，见 FASTGPT_API.md「流式行为」            |
| 请求结束前一个字节都收不到          | Nginx 缓冲没关，答案和收尾一起到 | `proxy_buffering off`（④里那行）                                 |
| 发了新版，用户看到的还是旧页面    | `index.html` 被缓存了         | 查②；也检查有没有在更外层配全局缓存                            |
| 全部 404                          | 配置没生效                    | `nginx -t` 看语法，确认软链建了、`systemctl reload nginx` 跑过 |

## HTTPS

正式对外服务建议上 HTTPS。最省事的路是 certbot：`sudo certbot --nginx -d 你的域名`，它会自动改这份配置加上证书并把 80 端口跳转到 443。手动配的话，在 `server` 块加 `listen 443 ssl;` 和 `ssl_certificate` / `ssl_certificate_key` 两行，再单开一个 80 端口的 `server` 块做 301 跳转。①—④的内容原样保留。
