"""应用装配：建 app，挂 lifespan、中间件、异常处理器和路由。

业务实现分布在 routes/（端点）、streaming/（流式中继）、security/（账号、
令牌、cookie）、history.py（上游历史缓存与合并）、errors.py（异常处理器
与共享文案）、upstream/（FastGPT 客户端持有点）；本文件只做装配。
"""

from fastapi import FastAPI

from server.errors import install_handlers
from server.lifespan import lifespan
from server.middleware import RefreshLoginCookie
from server.routes import routers
from server.security.headers import SecurityHeaders

app = FastAPI(lifespan=lifespan)

app.add_middleware(RefreshLoginCookie)
app.add_middleware(SecurityHeaders)
install_handlers(app)
for _router in routers:
    app.include_router(_router)
