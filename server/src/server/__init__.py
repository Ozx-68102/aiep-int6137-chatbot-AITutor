import uvicorn

__all__ = ["main"]


def main() -> None:
    from server.app import app

    uvicorn.run(app, host="127.0.0.1", port=3001)
