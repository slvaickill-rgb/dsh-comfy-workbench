"""图库 NSFW 打标器（WD14），常驻进程：模型只加载一次。

用法：python nsfw-tagger.py <model.onnx> <tags.csv>
stdin  每行 {"id": 1, "path": "C:/..."}
stdout READY 一行 {"ready": true, "side": 448, "tags": 10861, "keys": [...]}
       之后每行 {"id": 1, "ok": true, "rating": {"general": .., "sensitive": ..,
                   "questionable": .., "explicit": ..}}
判定阈值留在宿主算，这里只报分数。
"""

import sys
import json
import csv
import os

import numpy as np
from PIL import Image
import onnxruntime as ort


def load_tag_names(csv_path):
    names = []
    with open(csv_path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        next(reader, None)
        for row in reader:
            if len(row) > 1:
                names.append(row[1])
    return names


def main():
    # Windows 控制台默认 GBK：中文路径喂进来会变乱码，两头都钉死 utf-8。
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    model_path = sys.argv[1]
    tags_path = sys.argv[2]
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.enable_cpu_mem_arena = False
    session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
    model_input = session.get_inputs()[0]
    output_name = session.get_outputs()[0].name
    side = int(model_input.shape[1])
    names = load_tag_names(tags_path)
    positions = {}
    for index, name in enumerate(names):
        positions[name] = index
    keys = [key for key in ("general", "sensitive", "questionable", "explicit") if key in positions]
    sys.stdout.write(json.dumps({"ready": True, "side": side, "tags": len(names), "keys": keys}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue
        rid = request.get("id")
        try:
            image = Image.open(request["path"]).convert("RGB")
            ratio = float(side) / max(image.size)
            size = (max(1, int(image.size[0] * ratio)), max(1, int(image.size[1] * ratio)))
            image = image.resize(size, Image.LANCZOS)
            square = Image.new("RGB", (side, side), (255, 255, 255))
            square.paste(image, ((side - size[0]) // 2, (side - size[1]) // 2))
            array = np.asarray(square, dtype=np.float32)[:, :, ::-1][None, ...]
            probs = session.run([output_name], {model_input.name: array})[0][0]
            rating = {}
            for key in keys:
                rating[key] = float(probs[positions[key]])
            sys.stdout.write(json.dumps({"id": rid, "ok": True, "rating": rating}) + "\n")
        except Exception as error:
            sys.stdout.write(json.dumps({"id": rid, "ok": False, "error": str(error)[:200]}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
