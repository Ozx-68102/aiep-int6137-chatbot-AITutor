from furl import furl


def join_url(base: str, path: str) -> str:
    suffix = path.strip("/")
    if suffix == "":
        return furl(base).url
    return furl(base).add(path=suffix).url
