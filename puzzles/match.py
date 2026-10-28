# 광고 닫기 버튼 모양 기억·찾기 (이미지 비교, Claude 안 씀)
#   crop  <shot.png> <x_pt> <y_pt> <scale> <out.png> [size_pt]   : 탭한 자리 주변을 pt 해상도 흑백으로 잘라 저장
#   match <shot.png> <scale> <tpl1.png> [tpl2.png ...]            : 화면 위·아래 띠에서 가장 비슷한 자리 찾기 → JSON
import json
import sys

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from PIL import Image


def gray_pt(path, scale):
    im = Image.open(path).convert("L")
    w, h = im.size
    return np.asarray(im.resize((round(w / scale), round(h / scale)), Image.BILINEAR), dtype=np.float32)


def crop(shot, x, y, scale, out, size=30):
    g = gray_pt(shot, scale)
    h, w = g.shape
    r = size // 2
    x0, y0 = int(max(0, min(w - size, x - r))), int(max(0, min(h - size, y - r)))
    Image.fromarray(g[y0:y0 + size, x0:x0 + size].astype(np.uint8)).save(out)
    print(json.dumps({"ok": True, "offx": x - x0, "offy": y - y0}))


def ncc(region, tpl):
    th, tw = tpl.shape
    if region.shape[0] < th or region.shape[1] < tw:
        return None
    t = tpl - tpl.mean()
    tn = np.sqrt((t * t).sum())
    if tn < 1e-3:
        return None  # 무늬 없는 템플릿은 쓸모 없음
    win = sliding_window_view(region, (th, tw))
    wm = win.mean(axis=(2, 3))
    num = np.einsum("ijkl,kl->ij", win, t)
    wsq = np.einsum("ijkl,ijkl->ij", win, win) - th * tw * wm * wm
    flat = wsq < (th * tw) * 16.0   # 창 표준편차 4 미만(무늬 없음)은 제외
    den = np.sqrt(np.maximum(wsq, 1e-6)) * tn
    out = np.clip(num / den, -1, 1)
    out[flat] = 0
    return out


def match(shot, scale, tpls):
    g = gray_pt(shot, scale)
    h = g.shape[0]
    bands = [(0, min(h, 260)), (max(0, h - 130), h)]   # 위쪽 띠(X·>>·Skip), 아래쪽 띠(인앱 브라우저 X)
    best = {"score": -1}
    for tp in tpls:
        try:
            t = np.asarray(Image.open(tp).convert("L"), dtype=np.float32)
        except Exception:
            continue
        for y0, y1 in bands:
            s = ncc(g[y0:y1], t)
            if s is None:
                continue
            idx = np.unravel_index(np.argmax(s), s.shape)
            sc = float(s[idx])
            if sc > best["score"]:
                best = {"score": sc, "tpl": tp, "x": int(idx[1] + t.shape[1] / 2), "y": int(y0 + idx[0] + t.shape[0] / 2)}
    print(json.dumps(best))


if __name__ == "__main__":
    if sys.argv[1] == "crop":
        crop(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), sys.argv[6],
             int(sys.argv[7]) if len(sys.argv) > 7 else 30)
    else:
        match(sys.argv[2], float(sys.argv[3]), sys.argv[4:])
