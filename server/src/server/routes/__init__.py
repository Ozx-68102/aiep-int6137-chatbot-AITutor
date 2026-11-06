"""路由层：每个模块一个 APIRouter，app.py 统一挂载。"""

from server.routes import admin, auth, chat, events, profile, sessions, status

routers = [
    auth.router,
    admin.router,
    profile.router,
    status.router,
    events.router,
    sessions.router,
    chat.router,
]

__all__ = ["routers"]
