# ComfyUI 图库

DSH Web GUI 的图库插件，从左侧栏进入独立页面。浏览图片与生成参数，收藏、评分、打标签，比较图片、复用工作流、批量反推并导出 caption，按模型和 LoRA 筛选，支持指纹及 CLIP 内容相似分组，也可把图片加入对话草稿、上传外部图片反推。无第三方 Node 依赖，无构建步骤。

## 安装与打开

本机工作区：`C:\Users\34721\Documents\deepseek-harness\ComfyUI\plugins\dsh-comfyui-gallery`。
安装入口：`C:\Users\34721\.dsh\profiles\desktop\plugins\dsh-comfyui-gallery`，junction 指向工作区。

在 PowerShell 执行 `./scripts/install.ps1`。脚本保留 profile 配置备份，只追加本插件入口，并修改已有 HMR 的 root 列表；重复运行不会增加重复条目。无需修改 profile package.json，无需 pnpm。

打开 DSH 左侧栏 → **ComfyUI 图库**，图库在主内容区域显示。HMR 通常自动加载，必要时刷新窗口。

默认按时间倒序。支持文件名／已索引提示词搜索、子目录筛选、排序、刷新、加载更多。宽面板左右显示列表和详情；窄面板点击图片进入详情，使用“返回图库”返回。复制按钮显示“已复制”。颜色跟随 DSH 主题。

首次无索引时先返回扫描状态，后台扫描及预热完成后自动更新。以后列表直接读取内存索引，后台按需增量扫描；不会为每次请求重新解析所有 PNG。

## 图片加入对话与外部图片反推（0.4.0）

先打开目标对话，再从左侧进入图库。勾选图片后点 **添加到对话**，或在单张图片详情中点同名按钮。插件使用 DSH 原生附件草稿接口，追加图片并返回当前对话输入框，保留已有文字和附件；随后由你点击发送。每次 1–20 张、单张不超过 20 MB、合计不超过 100 MB。取图过程中切换对话会中止添加，提交中的草稿会提示稍后重试。普通对话支持此入口。

图库顶部点 **上传图片反推**，选择电脑上的图片，预览后点“开始反推”。外部图片支持 PNG／JPEG／WebP／GIF，单张不超过 20 MB、4000 万像素；动图读取第一帧。支持更换、移除图片、调整阈值、取消、复制结果、下载 caption。切回会话或关闭图库面板后反推继续运行，重新打开会恢复图片和任务。上传图片保存在本地，最多 20 张、合计 100 MB；删除最后一条关联记录或点击“移除图片及其反推记录”会释放对应图片。更换图片时，已有记录的旧图保留，未反推的旧图清理。

## 后台反推与记录（0.5.0）

图库顶部点 **反推记录**，查看单张、上传及批量反推的进度和结果；支持按图片名、提示词或模型搜索、按状态筛选、分页、复制提示词、下载 caption、取消任务和删除记录。上传记录可重新打开图片或将完成结果保存到图库。

最近 100 条记录写入 `~/.dsh-comfyui-gallery/interrogate-history.json`；上传图片及登记信息保存在 `uploads/retained/`。刷新窗口、切换页面和重新加载后可读取已有结果。任务依赖 DSH 后台进程，退出 DSH 或重载服务端插件会中断未完成任务；记录保留，重新打开原图后可再次反推。原图被移除时，已有提示词文本仍可查看。删除记录会清理不再使用的上传图片，已保存到图库的图片及提示词保留。旧版本已经清理的临时结果不会补入记录。

**保存到图库（0.4.1）**：上传图片反推完成后，结果下方点“保存到图库”，将图片、同名 `.txt` 提示词及 `.json` 反推信息一起保存到第一个配置的图库目录下的 **图库导入** 子目录。PNG／JPEG／WebP 保留原文件内容；GIF 保存第一帧 PNG。每次保存使用独立文件夹，同名图片互不覆盖，同一结果重复点击只保存一次；重新反推得到的新结果可单独保存。保存后可点“在图库中查看”，反推提示词可搜索、复制及导出 caption。原图若自带生成提示词，会与“已保存的反推标签”分别显示。清理临时图片、离开上传面板或重新加载插件都会保留已保存内容。图片只在点击保存后入库。

## 配置

可选配置文件：`C:\Users\34721\.dsh-comfyui-gallery\config.json`。也可以在插件 entry 的 config 块中覆盖。修改后重载插件。

```json
{
  "roots": ["D:\\Program Files\\Comfy UI\\ComfyUI\\output"],
  "thumbMax": 480,
  "pageSize": 60,
  "warmCount": 300,
  "registryRoots": [],
  "scanIntervalMs": 30000,
  "python": "D:\\Program Files\\Comfy UI\\python\\python.exe"
}
```

| 字段 | 含义 |
| --- | --- |
| roots | 图片根目录数组。未设置时自动检测本机 ComfyUI output 与工作区 out；显式空数组表示空图库。递归最多 4 层，不扫描 junction／符号链接目录。 |
| thumbMax | 缩略图最长边，默认 480，范围 64–2048。 |
| pageSize | 接口默认分页数量，默认 60，最大 200；界面每批 60 张。 |
| warmCount | 后台预热最近图片数量，默认 300；其余点击详情或手动补全全库参数索引时解析。提示词、模型与 LoRA 搜索覆盖已解析图片。 |
| registryRoots | 未设置 roots 时，额外探测这些 ComfyUI 安装目录下的 output 或 ComfyUI/output。 |
| scanIntervalMs | 列表触发后台扫描的最小间隔，默认 30 秒。刷新按钮立即请求重新扫描。 |
| python | 带 Pillow 的 Python。默认优先检测本机 ComfyUI Python，其次 DSH runtime Python。 |
| loraRoots | 可选的 LoRA 根目录数组；不设置时扫描 comfyRoot/models/loras，并读取本地 LoRA Manager 已启用的 LoRA 目录。显式空数组表示空 LoRA 库。 |
| loraManagerRoot | 可选的 SD-LoRA-Manager-Portable 目录，用于读取 config/settings.json 的 lora_paths；默认在 ComfyUI 的上级目录查找。只读取目录设置。 |

索引：`~/.dsh-comfyui-gallery/index.json`，写入防抖 5 秒，临时文件写完后原子替换。图片或同名 JSON 的大小／修改时间变化后重新提取。索引仅存搜索摘要与尺寸；详情使用有上限的内存缓存。原始图和工作流不会复制到索引。

缩略图：`~/.dsh-comfyui-gallery/thumbs/`。Pillow 生成 WebP，最多 4 个进程并发，同图并发请求合并；30 秒超时，插件卸载时终止生成任务。图片路径、大小、修改时间和缩略图尺寸共同构成缓存键。

## 本地 LoRA 库（0.7.0）

图库顶部点 **LoRA 库**。自动读取本机 ComfyUI 的 `models/loras`，并兼容 SD-LoRA-Manager-Portable 配置中的启用目录；可通过 `loraRoots` 指定多个目录。扫描最多 12 层，嵌套目录去重，目录链接不递归。搜索名称、路径、触发词、来源标签、分类和备注；支持目录、底模、自定义分类、来源标签、只看收藏筛选及分页。来源标签分类提供 Civitai 风格的常用分类按钮和其他标签下拉，多选时匹配任一标签；标签来自已有配套资料或手动抓取的公开模型资料。

在卡片点星收藏，详情可填写多个自定义分类和备注。数据独立保存在 `~/.dsh-comfyui-gallery/loras/library.json`，不修改权重、同名 JSON 或 LoRA Manager 收藏。底模优先读取元数据；缺少时显示目录推断并标注来源。索引缓存在 `loras/index.json`，再次扫描按文件及配套 JSON 的大小、修改时间增量更新。

详情展示：模型名称、版本、底模、作者、触发词、来源标签、说明、文件路径、训练 Dim／Alpha／网络／尺寸／步数／Epoch、训练标签频次、文件头原始元数据。训练标签与触发词分别展示。Safetensors 仅读取最多 16 MB 的 JSON 文件头，不加载模型权重。其他 `.ckpt/.pt/.bin` 文件只读取配套 JSON 和文件信息，不反序列化模型。

兼容同名 `.metadata.json`、`.civitai.info`、`.json` 及 `<模型文件名>.json`。优先使用 `.preview.png/.webp/.jpg` 等同名本地预览，也识别元数据中的本地预览路径，路径需位于当前模型根目录。缩略图复用现有 Pillow 与缓存队列。

在 LoRA 库点击 **一键抓取**，默认对当前筛选范围（跨全部分页）补全缺失的元数据和预览图；也可选择全部 LoRA，以及“重新抓取全部”。抓取前固定目标列表，资料变化不会使队列漏项。已有公开版本资料及本地／缓存预览的模型会跳过；使用“重新抓取全部”时重新查询公开元数据及下载可用预览。详情中的 **抓取预览与资料** 也会重新查询元数据。

抓取使用 Civitai 官方公开资料：已知版本 id 时直接查询；否则后台流式计算文件 SHA-256 查询。预览最多 20 MB，解码后生成 WebP 缩略图，资料及缩略图只写入插件缓存。元数据独立保存，图片下载失败或公开资料缺少图片时仍保留已获取的元数据。本地预览优先，模型和 LoRA Manager 配套文件保持原样。读取 Manager 的目录设置，不读取账号或 API key。

队列顺序执行，间隔 750 ms；界面显示当前模型、处理阶段、成功／跳过／失败数量及前 100 条失败明细，可取消。单个模型未公开或已删除时记录失败并继续；触发访问限制、请求频率限制或连续连接失败时停止后续抓取。切回对话或关闭图库面板后，DSH 后台继续抓取。最近一次进度与结果保存在 `loras/fetch-history.json`，重新打开可继续查看；退出 DSH 或服务端插件重载会中断未完成任务，重新打开显示已中断，再点“仅补全缺失”继续。不会自动恢复联网任务。

点击 **添加 LoRA 到对话**，把名称、本地及相对路径、底模、触发词、调用参考、说明和自定义备注插入当前普通对话输入框，由用户发送。使用原生可撤销文字插入接口，保留已有草稿与附件；读取期间切换对话、修改草稿或正在提交时会提示重新添加。模型权重留在本机。调用参考中的权重 1 是占位参考，需按模型说明调整。

LoRA API：GET `/loras?q=&folder=&base=&category=&tags=&favorite=1&offset=0&limit=40`（tags 为 JSON 字符串数组）、`/loras/item?id=…`、`/loras/thumb?id=…`、`/loras/job?id=…`、`/loras/batch`；POST `/loras/annotation`（`{id,patch:{favorite,categories,note}}`）、`/loras/refresh`（`{}`）、`/loras/fetch`（`{id}`）、`/loras/batch/start`（`{mode:"missing"|"all",filters:{q,folder,base,category,tags,favorite,missing}}`）、`/loras/batch/cancel`（`{}`）。所有写操作要求本次实例令牌。不会提供原始权重下载接口。

## 提示词反推

在图片详情的正／负向提示词下方展开 **提示词反推 · 本地 WD14**，选择模型后点“开始反推”。支持普通标签阈值（默认 0.35）、角色阈值（默认 0.85）、排除标签、下划线转空格、括号转义、字母排序、置信度权重、复制结果和取消任务。评分明细最多展示 200 项，完整结果均保留在提示词文本内。

使用已安装的 Python、Pillow、NumPy、ONNX Runtime 和本地模型。自动检测 `ComfyUI/custom_nodes/ComfyUI-WD14-Tagger/models/` 下配对的 `<模型名>.onnx` 与 `<模型名>.csv`；也接受单独目录中的 `model.onnx` + `selected_tags.csv`，与 SD-LoRA-Manager 的模型目录格式兼容。无需启动 ComfyUI 服务。CPU 推理限制 2 个计算线程，避免占用后台生图显存。

可在配置中增加 `comfyRoot`（ComfyUI 目录）、`wd14ModelDir`（额外模型目录）、`interrogateTimeoutMs`（单图超时，默认 180000，范围 10000–600000）。`python` 也用于反推。依赖或模型缺失时界面说明原因，“重新检测工具”重新扫描本地文件；不自动安装或下载。

每次只运行一个反推任务，最多接受另外 8 个等待任务；同图、同模型、同参数请求合并。图库图片结果缓存于 `~/.dsh-comfyui-gallery/interrogate/`，图片、模型、标签表或参数变化后失效。运行任务可取消，服务端插件卸载时终止进程。重新提交相同参数会复用已完成结果；切换页面后任务继续运行，返回可恢复查看，已完成结果同时写入反推记录。

反推只读取图片，结果单独存入缓存，不修改原图、元数据或同名提示词文件。它识别画面标签，无法保证与原作者提示词一致，也不反推 seed、LoRA 或负向提示词。本机另有 Florence2、JoyCaption 节点代码，但本轮未找到配套权重，这两种暂未接入；本轮未安装模型、节点或依赖。

## 接口

统一前缀 `/comfyui-gallery/api`。图库读取和刷新接受 GET／HEAD。写入、启动／取消计算和工作台提交均使用 POST，要求 JSON（图片上传使用二进制请求体）和本次插件实例的随机请求令牌；从 `/features` 或反推工具列表取得令牌，放入 `X-Gallery-Token` 请求头。单图反推请求最多 16 KiB，扩展功能请求最多 256 KiB。HEAD 不启动计算。

| 路径 | 功能 |
| --- | --- |
| `/interrogate/upload` | POST 二进制图片，返回临时 opaque id；校验实际格式和尺寸，20 MB 上限。 |
| `/interrogate/upload/remove` | POST `{id}`，取消关联任务、删除关联记录和上传图片。 |
| `/interrogate/upload/release` | POST `{id}`，更换图片时仅清理没有关联记录的上传图片。 |
| `/interrogate/upload/current?id=…` | GET：恢复指定上传图片及最近任务；省略 id 时返回最近上传图片。 |
| `/interrogate/upload/file?id=…` | GET／HEAD：读取已登记的上传原图。 |
| `/interrogate/upload/save` | POST `{id,jobId,name}`，将已完成的上传反推结果保存到图库；提示词从服务端任务读取，返回图库图片 id。需本轮令牌。 |
| `/health` | roots、Python 路径、缩略图缓存数量。 |
| `/list?offset=0&limit=60&q=&dir=&sort=desc` | 分页图片列表、总数、子目录与后台扫描状态。sort 可为 asc。 |
| `/item?id=…` | 正／负向、采样、模型、LoRA、尺寸、节点、分组；不含原始 JSON。 |
| `/file?id=…` | 原图，支持 HEAD、ETag、304、一天缓存。 |
| `/thumb?id=…` | 最长边受配置约束的 WebP 缩略图。 |
| `/raw?id=…&kind=prompt` | 原始 API 图 JSON 文本。kind 也可为 workflow。缺少数据时 404。 |
| `/refresh` | 立即增量扫描，返回 total。 |
| `/interrogate/tools` | GET：本地 WD14 模型、依赖就绪状态、请求令牌。 |
| `/interrogate` | POST：`{id, tool:"wd14", model, options}`，202 返回 jobId、状态及已有缓存结果。model 为工具列表给出的标识，不接受请求指定磁盘路径。 |
| `/interrogate/job?id=…` | GET：任务状态 queued／running／done／error／cancelled 及完整结果。 |
| `/interrogate/latest?id=…` | GET：指定图片最近一次任务及完整结果。 |
| `/interrogate/history?q=&state=&offset=0&limit=20` | GET：最近 100 条持久化记录，搜索、状态筛选及分页摘要。 |
| `/interrogate/history/remove` | POST `{jobId}`，删除已结束记录及不再使用的上传图片；运行任务需先取消。 |
| `/interrogate/cancel` | POST：`{jobId}`，取消排队或运行任务。 |

id 为绝对路径 UTF-8 的 base64url；每次文件访问均校验白名单扩展名、目录边界和 realpath，拦截路径越界及目录链接越界。仅支持 `.png .jpg .jpeg .webp`。自定义路由沿用 DSH 的本地服务部署边界。

## 元数据说明

PNG 支持 tEXt、压缩／未压缩 iTXt、zTXt，读取像素流之前的文本块；同时读取 IHDR 的真实尺寸。原始 API prompt 是参数来源，workflow 只补充标题和分组。

超过 JavaScript 安全整数范围的 seed 按原始数字文本保存和复制，避免 64 位 seed 精度损失。

多输出工作流会结合 SaveImage 的 filename_prefix 选择输出分支，再寻找最终采样节点；同时保留全部采样节点供检查。文件名只用于分支匹配，不推测参数。显式空负向与 ConditioningZeroOut 保持为空，避免混入其他分支文本。支持常见 KSampler 与 SamplerCustomAdvanced 的 noise／scheduler／guider 参数。

JPEG／WebP 可从同名 `.json` 或 `<图片名>.json` 读取 `prompt`／`workflow`。也接受 `rawPrompt`／`rawWorkflow`、`api_prompt`，以及平铺的 positive／negative／sampling。未保存元数据的图片显示文件信息；复杂自定义节点的参数以原始 prompt 为准。

## 验证

运行 `node scripts/self-test.mjs`（Node 20+，Python 带 Pillow；可用环境变量 GALLERY_PYTHON 指定）。覆盖压缩中文元数据、多个采样分支、空负向、模型与 LoRA、实际尺寸与 latent 尺寸、JPEG／WebP／sidecar、增量扫描、索引、越界及 junction、缩略图并发、GET／HEAD／304／405、客户端注册与卸载。

本机实际集成验证结果另见 `VALIDATION.md`。

`npm test` 共 375 项检查：基础 51 项、单图反推 33 项、图库扩展 61 项、分组算法 5 项、上传与对话草稿 45 项、保存上传反推结果 39 项、后台与反推记录 34 项、LoRA 库 61 项、LoRA 批量抓取与界面操作 46 项。LoRA 检查覆盖文件头及配套资料、分类收藏持久化、并发更新、筛选分页、真实缩略图、路径和文件头限制、在线资料模拟、后台抓取、损坏图片保护、缓存重载、接口令牌及原生草稿插入模拟。生成提交使用模拟工作台，不实际出图；不进行截图验证。

## 收藏、评分和搜索

卡片下方可选择图片或点星收藏。详情中的“收藏与整理”提供 0–5 分、最多 30 个自定义标签及 4000 字备注，编辑后点“保存标记”。数据独立写入 `~/.dsh-comfyui-gallery/library.json`，保存采用串行原子替换；读取异常时保留原文件并停止覆盖。

展开顶部筛选，可按收藏、最低评分、标签、模型、LoRA 组合筛选；先筛选全库再分页。模型和 LoRA 依赖元数据索引，点“补全全库参数索引”后台补全，可暂停后继续。搜索同时覆盖文件名、已索引正负向、备注、自定义标签和已保存的单图／批量 WD14 文本。图片变化会使反推文本失效。模型与 LoRA 依据图片保存的参数，未保存的内容不会被猜测。

## 对比与参数复用

多选 2–4 张后点“对比”。图片使用同步缩放与按比例同步滚动；提示词、尺寸、采样参数、模型、LoRA 权重的差异高亮显示。

详情点“带入参数复用工作台”，保留原始 API 图及所有连接，只开放提示词、seed、采样、尺寸、模型与 LoRA 等已有标量参数。可下载编辑后的 API 工作流、原始界面工作流或复制摘要。图片未保存 API 图时提供摘要复用，不拼造节点。界面 workflow 缺失时下载按钮会说明错误。

点击“通过生成工作台提交”才实际生成。图库复用本机 `dsh-comfyui-workbench` 的 `createComfyUIWorkflowTool`，写入缓存工作流文件并通过 `workflow_path` 提交；ComfyUI 需已启动，所需节点和模型需已存在。图库内的复用表单独立于已有插件的配置页；没有修改该插件。一个草稿成功提交一次，再次生成需重新带入。超出安全整数范围的 seed 可保真下载，但直接提交需先换成较小 seed。

## 批量反推与 caption

跨页最多选择 200 张，点“批量反推”设置 WD14 模型和同批阈值／格式。任务顺序执行，界面显示进度、错误和取消入口，成功部分立即保存。一个图库实例同时运行一个批量任务；单图和批量共用反推队列。返回图库再打开面板可继续查看当前会话任务。

选中图片后点“导出 caption”，或从批量面板导出已有成功结果。下载 UTF-8 ZIP：每张图片一个独立文件夹及同名 TXT，另附图片标识到 caption 路径的 manifest，防止不同目录同名图片相互覆盖。没有结果的图片跳过并告知数量。导出不会写回图片目录，也不会覆盖原有 TXT。

## 相似图分组

从“相似图分组”手动开始，范围可为已选图片或全图库。结果每页 20 组，组内逐步展开，单组最多展示 200 张；可查看详情、选图或对比前四张。只分组供人工检查，不自动删除文件。

视觉指纹模式使用 32×32 灰度 DCT 的 64 位 pHash，忽略 DC 位，阈值为严格 3／标准 6／宽松 10 个差异位；额外约束宽高比差不超过 0.2，适合缩放、压缩后的近似重复图。内容模式用本地 CLIP ViT-H，CPU 两线程、bfloat16 按张提取并量化缓存 1024 维特征，以余弦相似度 .94／.88／.80 分组，适合题材、布局相似图。阈值是经验值，需要人工判断。

两种模式均以代表图为锚点，成员直接与代表图匹配，避免相似链把差异很大的图片串在一起。算法采用逐组比较，最坏为平方级，全库较大时建议先选定范围。特征缓存于 `~/.dsh-comfyui-gallery/similarity.json`，文件或模型变化后失效；取消保留已完成缓存。只在有未索引图片时加载 CLIP；索引完毕后子进程退出释放资源。单次上限四小时。

本机复用 `ComfyUI/models/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` 与 `ComfyUI/comfy/clip_vision_config_h.json`，依赖现有 torch、transformers、safetensors、NumPy、Pillow。可设置 `similarityModel` 指向同架构的本地文件，配置由 `comfyRoot` 提供。不自动下载模型或安装依赖。内容模式通常占用约 2 GB 内存，首次索引慢于指纹模式。

扩展接口：GET `/features`、`/facets`、`/annotation?id=…`、`/batch/job?id=…`、`/similarity/job?offset=0&limit=20`。POST `/annotation`（`{id,patch}`）、`/catalog/start`、`/catalog/cancel`、`/batch/start`（`{ids,model,options}`）、`/batch/cancel`（`{jobId}`）、`/captions`（`{ids}`）、`/similarity/start`（`{ids}` 或 `{all:true,mode,level}`）、`/similarity/cancel`、`/reuse/prepare`（`{id}`）、`/reuse/export` 和 `/reuse/submit`（`{draftId,edits:[{node,key,value}]}`）。工作流草稿、任务进度和分组列表属于当前插件会话；标记、反推文本和特征缓存跨会话保留。

新增检查：外部图片真实 Pillow 校验、格式／尺寸／容量边界、HTTP 上传与移除、临时清理、原生附件草稿接口模拟、已有草稿保留、对话切换保护、上传面板预览和卸载清理。对话附件未执行真实发送。


## 图库界面（0.7.0）

顶部独立导航：图片、LoRA 库、上传图片反推、反推记录、相似图分组。图片筛选和多选操作只在图片页显示；选中后出现添加到对话、对比、批量反推和 caption 导出，切回图片页保留已有选择。高级筛选可折叠并显示启用数量。

图片详情的“查看大图”会在独立预览层显示原图，按 Esc 或点关闭返回；也可点击图片使用原有的新窗口入口。

卡片采用统一方形预览、清晰的收藏状态和底模标签。LoRA 库增加“待补全资料”、排序、清除筛选、明确的页码及抓取控制区。窄窗口中导航可横向滚动，筛选区独立滚动，详情保留返回与常用操作；颜色跟随 DSH 主题。未进行截图验证；通过真实浏览器计算不同宽度下的尺寸、溢出和卡片布局。
