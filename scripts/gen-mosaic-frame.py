"""生成演示站用的「直播截帧」JPEG（给画面遮挡编辑器用，前端只接受 image/jpeg）。

输出：app/lib/mock/mosaic-frame-data.ts（base64 常量 + 尺寸），以及 public/demo/mosaic-frame.jpg 供人工查看。
"""
import base64
import io
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 960, 540
img = Image.new("RGB", (W, H), (12, 16, 28))
d = ImageDraw.Draw(img)

# 背景渐变（从深蓝紫到近黑）
for y in range(H):
    t = y / H
    r = int(24 + 60 * (1 - t))
    g = int(20 + 30 * (1 - t))
    b = int(52 + 90 * (1 - t))
    d.line([(0, y), (W, y)], fill=(r, g, b))

# 模拟画面里的窗光 / 高光
d.ellipse([W * 0.62, -H * 0.25, W * 1.12, H * 0.55], fill=(58, 74, 120))
d.ellipse([W * 0.02, H * 0.55, W * 0.5, H * 1.2], fill=(30, 34, 58))

# 地平线 + 网格，像一帧视频画面
d.line([(0, int(H * 0.68)), (W, int(H * 0.62))], fill=(90, 120, 180), width=2)
for i in range(1, 9):
    x = int(W * i / 9)
    d.line([(x, int(H * 0.62) - 6), (x, H)], fill=(44, 56, 88), width=1)
for i in range(1, 5):
    y = int(H * 0.62 + (H * 0.38) * i / 5)
    d.line([(0, y), (W, y)], fill=(40, 52, 82), width=1)

def font(size: int) -> ImageFont.FreeTypeFont:
    for path in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()

d.text((28, 22), "演示站直播截帧（Mock）", font=font(30), fill=(236, 242, 255))
d.text((28, 66), "画面遮挡区域按百分比保存，最多 32 个", font=font(20), fill=(170, 186, 220))

# 左上 LIVE 角标
d.rounded_rectangle([W - 132, 24, W - 28, 60], radius=6, fill=(245, 34, 45))
d.text((W - 118, 31), "LIVE", font=font(22), fill=(255, 255, 255))

# 右下时间码
d.text((W - 250, H - 44), "00:42:17 / 4K", font=font(20), fill=(210, 220, 240))

buf = io.BytesIO()
img.save(buf, "JPEG", quality=72, optimize=True)
data = buf.getvalue()

os.makedirs("public/demo", exist_ok=True)
with open(os.path.join("public", "demo", "mosaic-frame.jpg"), "wb") as f:
    f.write(data)

b64 = base64.b64encode(data).decode("ascii")
ts = (
    "// 本文件由 scripts/gen-mosaic-frame.py 生成，勿手改。\n"
    "// 960x540 的「直播截帧」JPEG：画面遮挡编辑器只接受 image/jpeg，\n"
    "// 演示站没有真实流，用这张静态帧代替（约 {kb} KB，base64 内联）。\n".format(kb=round(len(data) / 1024))
    + f"export const MOSAIC_FRAME_WIDTH = {W}\n"
    + f"export const MOSAIC_FRAME_HEIGHT = {H}\n"
    + "export const MOSAIC_FRAME_JPEG_BASE64 =\n  '" + b64 + "'\n"
)
with open(os.path.join("app", "lib", "mock", "mosaic-frame-data.ts"), "w", encoding="utf-8", newline="\n") as f:
    f.write(ts)

print("jpeg bytes", len(data), "base64", len(b64), "-> public/demo/mosaic-frame.jpg + app/lib/mock/mosaic-frame-data.ts")
