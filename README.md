# ComfyUI Gallery

面向 DeepSeek Harness（DSH）的 ComfyUI 图库插件。从 DSH 左侧栏打开，浏览生成图片、查看生成参数、管理提示词和 LoRA，并把图片或模型信息带回当前对话。

## 功能

- 图片图库：缩略图、详情、大图预览、搜索、排序、目录筛选和分页。
- 生成信息：正向提示词、负向提示词、采样参数、尺寸、模型、LoRA、工作流和原始元数据。
- 图片整理：收藏、评分、自定义标签、备注和批量选择。
- 对话操作：把选中的图片、提示词或 LoRA 信息加入当前对话草稿。
- 提示词反推：使用本地 WD14 模型进行单图、上传图片和批量反推。
- 反推记录：任务在后台运行，切换页面后仍可查看进度和结果。
- LoRA 库：读取本地 LoRA，显示元数据和预览图，支持分类、收藏、标签筛选和资料抓取。
- 相似图分组：使用 pHash 或本地 CLIP 查找近似图片和相似构图。
- 工作流复用：编辑已有参数并提交到 ComfyUI 工作台。
- 本地优先：图片、模型文件和用户数据保留在本机。

## 环境要求

- DeepSeek Harness（DSH）桌面版
- Node.js 20 或更高版本
- ComfyUI
- Windows、Linux 或 macOS
- 使用提示词反推时，需要带 Pillow、NumPy 和 ONNX Runtime 的 Python 环境
- 使用 CLIP 相似图分组时，需要兼容的 CLIP Vision 模型和 Python 依赖

插件没有第三方 Node.js 运行时依赖，也不需要构建步骤。

## 安装

将仓库克隆到 DSH 配置目录下的插件目录：

~~~text
<DSH profile>/plugins/dsh-comfyui-gallery
~~~

在仓库目录运行：

~~~powershell
./scripts/install.ps1
~~~

脚本会添加 DSH 插件入口、加入 HMR 监视范围，并为已有配置创建备份。安装完成后重启 DSH，或按 DSH 提示重新加载插件，然后从左侧栏打开 **ComfyUI 图库**。

如果 DSH 安装目录不同，可以指定路径：

~~~powershell
./scripts/install.ps1 -Workspace "<DSH profile>/plugins/dsh-comfyui-gallery" -Profile "<DSH profile>"
~~~

## 配置

插件默认查找 ComfyUI 的输出目录和模型目录。需要自定义路径时，在 DSH 用户数据目录创建：

~~~text
<DSH user data>/dsh-comfyui-gallery/config.json
~~~

示例：

~~~json
{
  "roots": ["<ComfyUI>/output"],
  "loraRoots": ["<ComfyUI>/models/loras"],
  "comfyRoot": "<ComfyUI>",
  "python": "<Python executable>",
  "thumbMax": 480,
  "pageSize": 60,
  "warmCount": 300,
  "scanIntervalMs": 30000
}
~~~

| 字段 | 说明 |
| --- | --- |
| roots | 图片根目录数组。 |
| loraRoots | LoRA 根目录数组。 |
| comfyRoot | ComfyUI 根目录。 |
| loraManagerRoot | SD-LoRA-Manager-Portable 根目录。 |
| python | 缩略图和反推使用的 Python。 |
| thumbMax | 缩略图最长边，默认 480。 |
| pageSize | 列表分页数量，默认 60。 |
| warmCount | 启动时预热的图片数量，默认 300。 |
| wd14ModelDir | 额外 WD14 模型目录。 |
| similarityModel | CLIP Vision 模型路径。 |
| interrogateTimeoutMs | 单张反推超时时间，默认 180000 毫秒。 |

配置文件只保存在本机，不要提交到公共仓库。

## 提示词反推

图片详情和上传图片面板支持本地 WD14 反推。插件可识别配对的 ONNX 与 CSV 文件、ComfyUI-WD14-Tagger 模型目录，以及 SD-LoRA-Manager 兼容模型目录。

支持标签阈值、排除标签、格式化、单图、上传图片、批量任务、复制结果、下载 caption、取消任务和历史记录。WD14 主要输出画面标签，不会恢复原始 seed、LoRA 权重或作者未公开的提示词。

## LoRA 库

LoRA 库会扫描 ComfyUI 和可选的 LoRA Manager 目录，读取 safetensors 文件头、同名 JSON、Civitai 信息文件和本地预览图。

支持底模、作者、版本、触发词、训练信息、自定义分类、收藏、备注、来源标签、标签筛选、分页、批量抓取公开元数据和预览图，以及将 LoRA 调用信息加入当前对话。插件不加载或修改原始模型权重。

## 相似图分组

- **pHash**：适合查找缩放、压缩或轻微修改后的近似重复图。
- **CLIP**：适合查找主题、构图或视觉内容相近的图片。

分组结果只用于人工检查，不会自动删除文件。

## 数据与隐私

图片索引、缩略图、收藏、备注、反推记录和相似度缓存都保存在本机 DSH 用户数据目录中。联网功能只在主动使用公开资料抓取时访问对应服务。

提交问题时，请移除日志中的本机路径、用户名、Token 和私人图片。

## 开发与测试

在仓库根目录运行：

~~~powershell
npm test
~~~

测试使用隔离 fixture 和模拟网络，不会启动真实出图，也不会修改用户的图片、LoRA 或对话草稿。

## 许可证

MIT
