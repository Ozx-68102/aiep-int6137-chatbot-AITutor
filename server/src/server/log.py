import logging

_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure_logging() -> None:
    logging.getLogger("server").setLevel(logging.INFO)
    if logging.getLogger().handlers:
        return

    logging.basicConfig(level=logging.INFO, format=_FORMAT)
