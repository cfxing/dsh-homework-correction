#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
作业批改 · 本机 OCR 服务（零成本离线）
------------------------------------------------------------
作用：把「窗口1 · 作业批改」里的作业照片在本机做一次文字识别，
      把识别文本作为"既定事实"交给大模型判卷，避免大模型看错手写字母。

引擎：优先用 RapidOCR（PP-OCRv5/ONNX，装好即可离线跑）；
      没装 RapidOCR 时自动退回 PaddleOCR；都没有就报清楚的提示。

启动：双击同目录的「作业批改-启动OCR.bat」，或：
      F:\\dsh\\ocr-venv\\Scripts\\python.exe hwgrade-ocr.py

接口（只监听 127.0.0.1，浏览器同源策略已放开 CORS）：
  GET  /health        服务与引擎状态
  POST /ocr           {"image": "data:image/jpeg;base64,..."}  -> {"text": "...", "lines": [...]}
"""
import base64
import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("HWGRADE_OCR_PORT", "8897"))
MAX_BODY = 40 * 1024 * 1024

ENGINE = None
ENGINE_NAME = "未就绪"
ENGINE_ERR = ""


def load_engine():
    """按 RapidOCR -> PaddleOCR 的顺序找一个能用的引擎"""
    global ENGINE, ENGINE_NAME, ENGINE_ERR
    # 方向分类器（use_cls）对"整页作业照片"反而会把部分手写行当倒置文字误读，默认关闭
    use_cls = os.environ.get("HWGRADE_OCR_CLS", "0") not in ("0", "", "false", "False")
    try:
        from rapidocr_onnxruntime import RapidOCR
        try:
            ENGINE = RapidOCR(use_cls=use_cls)
        except TypeError:
            ENGINE = RapidOCR()
        ENGINE_NAME = "RapidOCR(PP-OCR/ONNX" + (",cls" if use_cls else "") + ")"
        return
    except Exception as e:
        ENGINE_ERR = "RapidOCR 不可用：%s" % e
    try:
        from paddleocr import PaddleOCR
        ENGINE = PaddleOCR(use_angle_cls=use_cls, lang="ch", show_log=False)
        ENGINE_NAME = "PaddleOCR"
        return
    except Exception as e:
        ENGINE_ERR += "；PaddleOCR 也不可用：%s" % e
    ENGINE = None
    ENGINE_NAME = "无可用引擎"


def decode_image(data_url):
    s = str(data_url or "")
    if "," in s and s.strip().lower().startswith("data:"):
        s = s.split(",", 1)[1]
    raw = base64.b64decode(s)
    try:
        from PIL import Image  # 可选：统一转成 RGB 数组，兼容带透明通道的图
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        import numpy as np
        return np.array(im)
    except Exception:
        return raw


def run_ocr(img):
    """返回 (整段文本, 行列表)"""
    if ENGINE is None:
        raise RuntimeError(ENGINE_NAME + "：" + ENGINE_ERR)
    res = ENGINE(img)
    lines = []
    # RapidOCR: (list[[box, text, score]], elapse) ；PaddleOCR: [[ [box,(text,score)], ... ]]
    payload = res[0] if isinstance(res, (list, tuple)) and res and isinstance(res[0], list) else res
    if payload:
        for item in payload:
            try:
                if isinstance(item, dict):
                    txt = item.get("text") or item.get("rec_text") or ""
                    score = float(item.get("score") or item.get("rec_score") or 0)
                    box = item.get("box") or item.get("dt_boxes") or []
                else:
                    box, txt, score = item[0], item[1], (item[2] if len(item) > 2 else 0)
                    score = float(score)
                txt = str(txt).strip()
                if txt:
                    lines.append({"text": txt, "score": round(score, 3), "box": box})
            except Exception:
                continue
    text = "\n".join(l["text"] for l in lines)
    return text, lines


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):   # 安静一点，只留关键信息
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {
                "ok": ENGINE is not None,
                "service": "作业批改 · 本机 OCR",
                "engine": ENGINE_NAME,
                "error": ENGINE_ERR,
                "port": PORT,
                "hint": "把这个地址填进「窗口1 · 作业批改」的本机 OCR 地址：http://%s:%d" % (HOST, PORT),
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/save"):
            # 把批注好的图片存进项目文件夹（浏览器下载不了/想自动归档时用）
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8"))
                rel = str(body.get("path") or "").strip().replace("\\", "/")
                data = str(body.get("image") or "")
                if not rel or not data:
                    self._json(400, {"ok": False, "error": "缺少 path 或 image"})
                    return
                if "," in data and data.strip().lower().startswith("data:"):
                    data = data.split(",", 1)[1]
                raw = base64.b64decode(data)
                root = os.path.dirname(os.path.abspath(__file__))
                target = os.path.normpath(os.path.join(root, rel))
                if not target.startswith(root):
                    self._json(400, {"ok": False, "error": "只允许写进项目文件夹"})
                    return
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(raw)
                print("[save] %s (%.0f KB)" % (target, len(raw) / 1024.0), flush=True)
                self._json(200, {"ok": True, "path": os.path.relpath(target, root).replace("\\", "/"), "bytes": len(raw)})
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
            return
        if not self.path.startswith("/ocr"):
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                self._json(400, {"error": "图片太大或请求为空"})
                return
            body = json.loads(self.rfile.read(n).decode("utf-8"))
            img = decode_image(body.get("image"))
            t0 = time.time()
            text, lines = run_ocr(img)
            self._json(200, {
                "ok": True,
                "engine": ENGINE_NAME,
                "elapsed": round(time.time() - t0, 2),
                "text": text,
                "lines": lines,
            })
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e), "engine": ENGINE_NAME})


def main():
    print("")
    print("  作业批改 · 本机 OCR 服务")
    print("  ----------------------------------------")
    print("  正在加载识别引擎（首次启动会稍慢）…")
    load_engine()
    print("  引擎     : %s" % ENGINE_NAME)
    if ENGINE is None:
        print("  [!] %s" % ENGINE_ERR)
        print("  [!] 请先安装： F:\\dsh\\ocr-venv\\Scripts\\python.exe -m pip install rapidocr-onnxruntime")
    print("  监听地址 : http://%s:%d" % (HOST, PORT))
    print("  健康检查 : http://%s:%d/health" % (HOST, PORT))
    print("  ----------------------------------------")
    print("  保持这个窗口开着；回到「窗口1 · 作业批改」勾选「先用本机 OCR 转写」。")
    print("")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
