"""thumb-worker.py -- 图库缩略图常驻进程（ComfyUI .venv 的 Pillow）。

协议：stdin 一行一个 JSON 请求，stdout 一行一个 JSON 应答。

    {"id": 1, "src": "C:\\out\\a.png", "dst": "C:\\cache\\<key>.jpg", "w": 320}
    {"id": 1, "ok": true}
    {"id": 1, "ok": false, "error": "..."}

dst 先写 .part 再 os.replace：半截文件不会留在缓存里，宿主也不会读到。
透明图铺白底再转 JPEG，不然缩略图会黑一块。
"""

import json
import os
import sys

from PIL import Image


def render(src, dst, width):
    with Image.open(src) as image:
        image.thumbnail((width, width * 2))
        if image.mode in ("RGBA", "LA", "P"):
            flat = Image.new("RGB", image.size, (255, 255, 255))
            with image.convert("RGBA") as rgba:
                flat.paste(rgba, mask=rgba.split()[-1])
            image = flat
        else:
            image = image.convert("RGB")
        temp = dst + ".part"
        image.save(temp, "JPEG", quality=82, optimize=False, progressive=False)
    os.replace(temp, dst)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue
        if request.get("quit") is True:
            break
        rid = request.get("id")
        try:
            render(request["src"], request["dst"], int(request.get("w") or 320))
            answer = {"id": rid, "ok": True}
        except Exception as error:
            answer = {"id": rid, "ok": False, "error": str(error)[:300]}
        sys.stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
