"""头像的处理。

存进数据库的是处理过的图（256 见方的 PNG），不是用户传上来的原图：
数据库里的大小可控，返回的类型固定，原图里带的 EXIF 也不会跟着走。

收 PNG、JPEG、HEIC。iPhone 拍的照片默认是 HEIC，Pillow 自己解不了，
要注册 pillow-heif 的打开器。

SVG 不收：同源下它能带脚本。
"""

from io import BytesIO

import pillow_heif
from PIL import Image, ImageOps, UnidentifiedImageError

pillow_heif.register_heif_opener()

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 20_000_000
SIZE = 256
_ALLOWED_FORMATS = frozenset({"PNG", "JPEG", "HEIF"})


class AvatarError(Exception):
    """上传的内容不是能用的头像。"""


def normalize(data: bytes) -> bytes:
    """把传上来的图处理成头像。处理不了就抛 AvatarError。"""
    if len(data) == 0:
        raise AvatarError("文件是空的")
    if len(data) > MAX_UPLOAD_BYTES:
        raise AvatarError("文件太大，请传 5 MB 以内的")

    try:
        image = Image.open(BytesIO(data))
        image_format = image.format
        if image_format is None or image_format not in _ALLOWED_FORMATS:
            raise AvatarError("只支持 PNG、JPEG、HEIC")
        if image.width * image.height > MAX_PIXELS:
            raise AvatarError("图片太大了")
        image.load()
    except AvatarError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise AvatarError("这不是能打开的图片") from error

    # 先按 EXIF 里的方向摆正，再转成 RGBA：重新编码以后 EXIF 就没了。
    image = ImageOps.exif_transpose(image).convert("RGBA")
    # 中间裁成正方形，再缩到头像的尺寸。
    image = ImageOps.fit(image, (SIZE, SIZE), method=Image.Resampling.LANCZOS)

    out = BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()
