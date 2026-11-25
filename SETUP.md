# 安装引导（SETUP）

> 这份文件同时给人看和给 **DSH 里的 agent** 看。换一台机器时，把整个插件目录拷过去，然后让 agent 读这一份、跑一次 `node tools/doctor.mjs`，按体检结果填配置就行。
> 目标：**从零到出第一张图**，不需要翻源码猜字段。

## 0. 三条前置（缺一条都不出图）

| 项 | 要求 | 不满足会怎样 |
|---|---|---|
| DSH | `>=0.2.2-rc.1 <0.2.3-0`（见 package.json 的 `engines`） | 插件加载不了，侧栏不出现 |
| ComfyUI | **≥ 0.41.3**，跑在 `127.0.0.1:8188` | 工作流提交报「CLIPLoader 没有 moss_image」或 `EmptyFlux2LatentImage` 不存在 |
| 出图权重 | 见 §3 四个文件（合计约 12.1 GB） | 出图下拉里工作流标 ⚠，列出 `missing` |

显存不是硬门槛：本套默认的 **4 步 / CFG 1 + INT8/W4A8 量化**，4 GB 显存能跑（1024² 约 24 秒）。

## 1. 装插件

```bash
# 1) 目录整个拷到目标机器（8 份工作流已导入到 workflows/，随包走；`format: local` 的手工条目重导时保留）
# 2) 在插件根目录执行：
node tools/install.mjs
# 3) 重启 DSH —— 新 bundle 不作用于正在跑的进程
```

`install.mjs` 会做两件事：在 `<profile>/node_modules/dsh-comfy-workbench` 建目录联接；往 profile 的 `package.json` 补
`dependencies["dsh-comfy-workbench"]` 和 `dsh.profile.bundles`。**缺这两项宿主会静默跳过插件**，只放文件没用。
不需要 `npm install`——插件没有运行时依赖。

装完验证：

```bash
curl http://127.0.0.1:61609/dsh-comfy/v1/health   # 端口换成你 DSH Web 的实际端口
```

## 2. 装 ComfyUI

两条路，选一条：

| 路线 | 怎么装 | 适合 |
|---|---|---|
| **Comfy Desktop（推荐）** | 从 <https://comfy.org/zh-CN/> 下载 Windows 安装包，装完把「模型目录」指到 §3 的目录 | 不想碰 python |
| **Portable / 手动** | <https://github.com/comfyanonymous/ComfyUI/releases> 下 Windows portable 包，或 git clone 后用 `.venv` 跑 `python main.py --port 8188` | 要自己升级 core、要 git 版本管理 |

**版本必须 ≥ 0.41.3**（这是 MOSS-Image 原生支持的门槛）。查版本：页面右上角，或 `curl http://127.0.0.1:8188/system_stats`。
低于这个版本要么升级（git checkout 对应 tag + `pip install -r requirements.txt`），要么整包换新。

启动参数建议（插件会把 input/output 读出来）：

```text
python main.py --port 8188 --input-directory "C:\Comfyui input" --output-directory "C:\DSH生图"
```

## 3. 放模型（缺的下这里）

四个必需文件、合计约 **12.1 GB**。下载源是 HuggingFace，国内可挂代理或用镜像：

| 文件 | 放到 ComfyUI 的 | 大小 | 下载 |
|---|---|---|---|
| `moss_image_sft_int8_convrot.safetensors` | `diffusion_models/`（或 `unet/`） | 5.41 GB | <https://huggingface.co/nif0/MOSS-Image-SFT-ComfyUI> |
| `qwen3.5_9b_moss_image_sft_w4a8_gptq.safetensors` | `text_encoders/`（或 `clip/`） | 5.43 GB | 同上 |
| `moss_image_vae_bf16.safetensors` | `vae/` | 0.12 GB | 同上 |
| `moss_image_sft_4step_v2.0.safetensors` | `loras/` | 1.19 GB | <https://huggingface.co/akhaliq/MOSS-Image-SFT-4-steps> |

- 官方未量化的 bf16 权重在 <https://huggingface.co/Comfy-Org/MOSS-Image>（DiT 10.16 GB + TE 19.31 GB），**16 GB 内存的机器别下**，跑不动。
- 本机用的是量化重打包（INT8 ConvRot + W4A8 GPTQ），ComfyUI 原生 loader 自动识别，不需要自定义节点。
- SHA-256 对一下（nif0 卡里给的）：

```text
ffd98820ac8f0f57c48386bd98852720de50c3acb502f73fd641d0cd9df6d0af  moss_image_sft_int8_convrot.safetensors
b5f31a430e4912decb152f3a0761350f52282176823b597edd43b2e3f6403da4  qwen3.5_9b_moss_image_sft_w4a8_gptq.safetensors
81a27c7135775f149648fa35a58eec6d78a3e6a9bb9273885b51895cbc212d5d  moss_image_vae_bf16.safetensors
```

**⚠ 最容易踩的坑**：文本编码器必须用 `qwen3.5_9b_..._w4a8_gptq`，有人会误用 `qwen_3_06b_base.safetensors`，
出图直接报 `mat1 and mat2 shapes cannot be multiplied (45x1024 and 4096x3072)`。

可选（对应进阶工作流）：`lora_3step`（3 步草稿）、`moss_pussy_lora_v2.0_8steps`（8 步高细节）、
`anireal_moss_lora_v1` / `skp_mossv2` / `ffstyle_moss_heal` / `muqiu_moss`（风格与角色 LoRA，都在 Civitai）。缺了只影响用到它的那几份工作流。

## 4. 模型不在 ComfyUI 目录里？写 extra_model_paths.yaml

插件优先读 **ComfyUI 根目录下的 `extra_model_paths.yaml`** 来找模型（比猜盘符可靠）：

```yaml
comfyui:
    base_path: D:/Comfyui model/
    checkpoints: checkpoints
    clip: clip
    diffusion_models: diffusion_models
    text_encoders: text_encoders
    loras: loras
    unet: unet
    vae: vae
    upscale_models: upscale_models
```

`base_path` 指到哪，插件就去哪扫；外部盘、局域网共享都行。没有这个文件就退到 ComfyUI 自带的 `models/`。
改完**重启 ComfyUI**（或者在页面点刷新），不然 `/object_info` 里还是旧清单。

## 5. 填配置（`config.json` 怎么填）

路径：`%USERPROFILE%\.dsh\profiles\desktop\.dsh-comfy\config.json`（没有就自己建，插件会补默认值）。
**大部分键留 `null` 会走自动探测**，真正需要你动的只有下面这几个：

| 键 | 填什么 | 例子 |
|---|---|---|
| `comfyRoot` | ComfyUI 程序根目录（含 `main.py` 和 `extra_model_paths.yaml`） | `C:/Comfyui Driver/ComfyUI/ComfyUI` |
| `output` | 出图落盘目录；插件会自动按 `moss/<年-月>` 分桶 | `C:/DSH生图` |
| `comfyUrl` | ComfyUI 地址，默认 `http://127.0.0.1:8188` | 留 `null` 即可 |
| `characterKbRoot` | 角色外貌知识库目录（可空，空则跳过锚定） | `C:/RP专用目录/萌娘百科知识库` |
| `catalogRoot` | 画风图库解压目录（可空） | `C:/Moss本地画风库` |
| `workflow` | 默认工作流 id，`null` = 用 `anima__Anima Aesthetic v1.1` 兜底 | `moss__moss-4step` |
| `width` / `height` / `steps` | 默认尺寸与步数 | `1024 / 1024 / 4` |
| `thinkingGif` | 改写时按钮上的动图，读不到自动退成三点动画 | 留默认即可 |
| `characterAnchor` | 自动给角色补外貌串（只对 moss 工作流） | `true` |
| `rewritePersona` | 改写时接不接全局 AGENTS.md 的 §4 内容尺度 | `true` |

最小可用的一份（换掉三个路径就行）：

```json
{
  "comfyRoot": "C:/Comfyui Driver/ComfyUI/ComfyUI",
  "comfyUrl": null,
  "output": "C:/DSH生图",
  "workspaceId": null,
  "workspacePath": null,
  "workflow": "moss__moss-4step",
  "checkpoint": "moss_image_sft_int8_convrot.safetensors",
  "loras": [],
  "width": 1024,
  "height": 1024,
  "steps": 4,
  "characterKbRoot": null,
  "characterAnchor": true,
  "rewritePersona": true
}
```

`workspaceId` / `workspacePath` 是**宿主的工作区 UUID 和路径，不能拷**，到新机器在页面「绑定工作区」重绑一次。

## 6. 验证

```bash
node tools/doctor.mjs     # 一次性体检：配置 / ComfyUI / 模型 / 工作流缺什么，缺的给下载地址
```

体检全绿之后，页面上：选工作流 → 写提示词 → 「生成一张」。首张图慢（要读 10.8 GB 进内存，1–3 分钟），之后 4 步档 20–40 秒。

## 7. 可选件（不装不影响出图）

| 功能 | 需要什么 | 从哪来 |
|---|---|---|
| NSFW 分级 / 毛玻璃 | ComfyUI 的 WD14 打标器：`custom_nodes/ComfyUI-WD14-Tagger/models/*.onnx` + 同名 `.csv`，以及 ComfyUI 的 `.venv` python | ComfyUI Manager 装 ComfyUI-WD14-Tagger，模型它会自己下 |
| 画风图库（314 画风 / 34,395 角色样张） | 解压后约 2 GB | <https://github.com/ukr8b3g-cmyk/MOSS-Image-Character-Catalog/releases> 下 v0.1.2 主 ZIP |
| 角色外貌锚定 | `萌娘百科知识库/*.md`（每份一个角色，`## 角色生成串` 那一节） | 自己积累；可用 comfyui-moss 的 `moegirl.mjs --char` 抓外貌字段建档 |

## 8. 故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 侧栏没有「ComfyUI 工作台」 | profile 的 `dependencies` / `bundles` 没登记，或没重启 | 重跑 `node tools/install.mjs`，重启 DSH |
| 页面「服务离线」 | ComfyUI 没起 / 端口不对 | 起 ComfyUI，或改 `comfyUrl` |
| 提交报 `CLIPLoader 没有 moss_image` | ComfyUI < 0.41.3 | 升 core |
| 提交报 `Required input is missing: device` | 旧工作流带 `device` 字段，0.42 已移除 | 用包内 `workflows/` 里的新版 |
| 报 `mat1 and mat2 shapes...` | 文本编码器用错 | 换 `qwen3.5_9b_..._w4a8_gptq` |
| 工作流标 ⚠ / 找不到模型 | 文件没放对、或 ComfyUI 没刷新 | 按 §3/§4 放，重启 ComfyUI |
| 4 步图发灰、字糊 | 分辨率 >1024 却仍 4 步 | 1536 用 6 步，2048 用 8 步 |
| 标准档整张雪花噪点 | 迁移了官方原档的 `ModelSamplingSD3` | 改 `ModelSamplingAuraFlow`（shift 5 / sampling flow）；本机 int8 重打包不认 SD3 |
| 出图极慢、硬盘狂转 | 内存不足在换页 | 关别的程序；别同时跑两个任务 |

## 9. 给 DSH agent 的一段话（贴进 `~/.dsh/AGENTS.md` 即可）

```markdown
## ComfyUI 工作台（dsh-comfy-workbench）

- 装机/换机/配置问题，先读插件的 `SETUP.md`，再跑 `node tools/doctor.mjs`；按体检输出填 `%USERPROFILE%\.dsh\profiles\desktop\.dsh-comfy\config.json`，不要靠猜路径。
- 只改这几个键：`comfyRoot` / `output` / `comfyUrl` / `characterKbRoot`；其余留 null 走探测。
- 模型缺文件时，下载地址：moss 三个文件在 https://huggingface.co/nif0/MOSS-Image-SFT-ComfyUI ，
  4step LoRA 在 https://huggingface.co/akhaliq/MOSS-Image-SFT-4-steps ，放错目录会让工作流标 missing。
- ComfyUI 必须 ≥ 0.41.3（`moss_image` 的 CLIP 类型和 `EmptyFlux2LatentImage` 才有）。
- 插件是 junction 安装，改源码要重启 DSH 才生效。
```
