# ComfyUI 工作台（dsh-comfy-workbench）

> 给 DSH 加一个本地出图面板：选工作流、写一句话、点「生成一张」。
> 默认 MOSS-Image 4 步蒸馏档，4 GB 显存能跑，1024² 约 24 秒，中文字渲染是它的强项。

作者：**slvaickill-rgb**

---

## 这是什么

一个 DSH 插件，把本地 ComfyUI 包成侧栏里的工作台。

| 能力 | 说明 |
|---|---|
| **一键出图** | 选工作流 → 写提示词 → 生成，产物落 `output/<源>/<年-月>/`，可存回工作区 |
| **11 份工作流** | MOSS 四档（4 步 / 8 步 / 开关版 / 完整版）、Anima（按 skill 的 style 档固化：16 步 / cfg 4 / dpmpp_2m / 单段）、WAI、FFstyle、木秋、塞卡、Anireal |
| **大模型改写** | 两阶段：先判要不要写负面，再按当前工作流的风格改写正向；走宿主 `ctx.llm`，插件不存 key |
| **角色锚定** | 提示词里点名知识库里的角色，自动补「作品 - 罗马音 - 外貌」串（只对 MOSS 工作流） |
| **图库** | 只读扫产物目录、缩略图、NSFW 分级、画风图库（314 画风 / 34,395 样张） |
| **放大 / 预览** | ESRGAN ×2 / ×4；生成过程逐步预览（latent2rgb / taesd） |

## 三条设计取舍

1. **插件不搬权重，只探盘。** 每次现场读 ComfyUI 的 `extra_model_paths.yaml`、`/object_info`、`models/`，
   所以模型放外置盘、放 NAS 都行；缺文件时工作流标 ⚠ 而不是报错。
2. **CFG=1 不写负面。** 4 步蒸馏档的负面分支根本不参与计算，写进去只是噪音；插件按工作流的实际 cfg 裁决。
3. **改写是「改」不是「创作」。** 只按工作流风格重排措辞，不新增设定；成人内容用全局人设的 §4 尺度兜底。

## 安装

```bash
node tools/install.mjs     # 建联接 + 登记 profile（幂等）
# 重启 DSH —— 新 bundle 不作用于正在跑的进程
```

要求：**DSH** `>=0.2.2-rc.1 <0.2.3-0`、**ComfyUI** `>=0.41.3`（低于它没有 `moss_image` 的 CLIP 类型）、
**Windows**（路径与拉起脚本按 Windows 写的），ComfyUI 跑在 `127.0.0.1:8188`。

出图要四个权重（MOSS 底模 / 文本编码器 / VAE / 4 步 LoRA，共约 12 GB），下载地址、放哪个目录、SHA-256
都写在 **[SETUP.md](SETUP.md)**；换机器、填 `config.json`、故障速查也在那份里。

## 快速验证

```bash
node tools/doctor.mjs             # 装机体检：安装登记 / ComfyUI / 模型 / 缺哪些文件
node tools/selftest-rewrite.mjs   # 39 项：负面判定矩阵、两阶段编排、超时取消
node tools/selftest-anchor.mjs    # 16 项：角色档案解析、命中、注入位置
node tools/selftest-client.mjs    # 16 项：页面静态断言
node tools/selftest-asset.mjs     # 8 项：动图路由
```

全部不联网、不需要 ComfyUI 在线。

## 适合 / 不适合

**适合**：本地单机出图、4 GB 显存、要中文字渲染（招牌 / 菜单 / 海报）、要明确手控每个参数。

**不适合**：要云端并发、要跨平台（macOS / Linux 未测）、要「一句话生成整套资产」。

## 文档

- **[SETUP.md](SETUP.md)** —— 安装引导：前置条件、ComfyUI 版本、权重下载、`config.json` 逐键说明、故障表。
- **[docs/NOTES.md](docs/NOTES.md)** —— 工程笔记：目录探测三级策略、图库性能实测、改写判定顺序、
  接口清单、验收记录、踩坑表。

## 许可

MIT
