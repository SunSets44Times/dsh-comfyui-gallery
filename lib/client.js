window.__ModuleLoader__.load({
  id: 'dsh-comfyui-gallery',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react'), h = React.createElement
    var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef
    var ID = '@local/dsh-comfyui-gallery', KIND = 'comfyui-gallery'
    var API = '/comfyui-gallery/api/'
    var interrogationSessions = new Map()

    function endpoint(name, params) { return API + name + '?' + new URLSearchParams(params || {}).toString() }
    async function request(name, params, signal, plain) {
      var response = await fetch(endpoint(name, params), { signal: signal })
      if (!response.ok) {
        var message = '请求失败（' + response.status + '）'
        try { message = (await response.json()).error || message } catch (_) { /* HTTP error */ }
        throw Object.assign(new Error(message), { status: response.status })
      }
      return plain ? response.text() : response.json()
    }
    function date(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
    function text(value) { return value === undefined || value === null ? '—' : String(value) }
    function bytes(value) { return value > 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB' }
    async function copy(value) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(String(value))
      var area = document.createElement('textarea')
      area.value = String(value); area.style.position = 'fixed'; area.style.opacity = '0'
      document.body.appendChild(area); area.select()
      var success = document.execCommand('copy'); area.remove()
      if (!success) throw new Error('请允许浏览器访问剪贴板')
    }
    function CopyButton(props) {
      var state = useState(''), status = state[0], setStatus = state[1]
      var timer = useRef()
      useEffect(function () { return function () { clearTimeout(timer.current) } }, [])
      return h('button', { type: 'button', className: 'cg-copy', disabled: props.value === undefined || props.value === null,
        'aria-label': '复制' + (props.label || ''), onClick: async function (event) {
          event.preventDefault(); event.stopPropagation()
          try { await copy(props.value); setStatus('已复制') } catch (error) { setStatus(error.message) }
          clearTimeout(timer.current); timer.current = setTimeout(function () { setStatus('') }, 2000)
        } }, h('span', { role: 'status' }, status || props.caption || '复制'))
    }
    function DeleteButton(props) {
      var cs = useState(false), confirming = cs[0], setConfirming = cs[1]
      var bs = useState(false), busy = bs[0], setBusy = bs[1]
      var es = useState(''), error = es[0], setError = es[1]
      useEffect(function () {
        if (!confirming) return
        // The confirmation times out on its own so a stray click can never arm a delete.
        var timer = setTimeout(function () { setConfirming(false) }, 10000)
        return function () { clearTimeout(timer) }
      }, [confirming])
      async function run() {
        setBusy(true); setError('')
        try { await props.onConfirm(); setConfirming(false) } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h('span', { className: 'cg-delete' },
        confirming
          ? h('span', { className: 'cg-delete-confirm', role: 'group', 'aria-label': props.confirm || '确认删除' },
            h('span', { className: 'cg-muted' }, (props.confirm || '确认删除') + '，删除后无法恢复'),
            h('button', { type: 'button', className: 'cg-danger', autoFocus: true, disabled: busy, onClick: run }, busy ? '删除中…' : '确认删除'),
            h('button', { type: 'button', disabled: busy, onClick: function () { setConfirming(false) } }, '取消'))
          : h('button', { type: 'button', className: 'cg-danger', disabled: props.disabled, onClick: function () { setConfirming(true) } }, props.label || '删除'),
        error ? h('span', { role: 'alert', className: 'cg-delete-error' }, error) : null)
    }
    function Field(props) {
      return h('div', { className: 'cg-field' }, h('span', { className: 'cg-muted' }, props.label),
        h('span', { className: 'cg-value' }, text(props.value)), h(CopyButton, { value: props.value, label: props.label }))
    }
    function Prompt(props) {
      return h('section', { className: 'cg-section' }, h('div', { className: 'cg-section-head' }, h('h3', null, props.label), h('div', { className: 'cg-actions' },
        h(CopyButton, { value: props.value || '', label: props.label }),
        props.allText !== undefined ? h(CopyButton, { value: props.allText, label: '全部提示词和参数', caption: '复制全部提示词和参数' }) : null)),
        h('details', { open: true }, h('summary', null, props.value ? '提示词 · ' + props.value.length + ' 字符' : '未保存提示词或内容为空'),
          props.value ? h('pre', { className: 'cg-prompt', tabIndex: 0 }, props.value) : null))
    }
    function RawData(props) {
      var kindState = useState(''), kind = kindState[0], setKind = kindState[1]
      var bodyState = useState(null), body = bodyState[0], setBody = bodyState[1]
      var errorState = useState(''), error = errorState[0], setError = errorState[1]
      useEffect(function () {
        if (!kind) return
        var controller = new AbortController()
        setBody(null); setError('')
        request('raw', { id: props.id, kind: kind }, controller.signal, true).then(setBody).catch(function (error) { if (error.name !== 'AbortError') setError(error.message) })
        return function () { controller.abort() }
      }, [props.id, kind])
      return h('section', { className: 'cg-section' }, h('h3', null, '原始数据'),
        h('div', { className: 'cg-actions' }, ['workflow', 'prompt'].map(function (value) {
          return h('button', { type: 'button', key: value, onClick: function () { setKind(kind === value ? '' : value) }, 'aria-pressed': kind === value }, value === 'workflow' ? '查看原始 workflow' : '查看原始 prompt')
        })), kind ? h('div', null, error ? h('p', { role: 'alert' }, error) : body === null ? h('p', { role: 'status' }, '正在读取…') : h('div', null,
          h('div', { className: 'cg-section-head' }, h('span', null, kind), h(CopyButton, { value: body, label: kind })),
          h('pre', { className: 'cg-raw', tabIndex: 0 }, body))) : null)
    }
    async function compute(name, body, token) {
      var response = await fetch(API + name, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': token }, body: JSON.stringify(body) })
      var value = await response.json()
      if (!response.ok) throw new Error(value.error || '反推请求失败')
      return value
    }
    async function attachImages(ctx, ids, signal) {
      if (!ids.length || ids.length > 20) throw new Error('每次可添加 1–20 张图片，请减少选择后重试')
      var current = ctx.uiSession.current.getSnapshot(), sessionId = current.key
      var binding = sessionId && ctx.sessions.binding(sessionId), conversation = ctx.conversation
      if (!binding) throw new Error('请先打开一个对话，再从左侧进入图库')
      if (binding.session.getSnapshot().subagent !== null) throw new Error('请切换到普通对话后添加图片')
      var shell = conversation.input.for(binding.ctx), files = [], total = 0
      for (var id of ids) {
        var detail = await request('item', { id: id }, signal)
        if (detail.size > 20 * 1048576 || total + detail.size > 100 * 1048576) throw new Error('单张图片限 20 MB，每次合计限 100 MB，请减少选择')
        var response = await fetch(endpoint('file', { id: id }), { signal: signal })
        if (!response.ok) throw new Error('读取图片失败，请刷新图库后重试')
        var blob = await response.blob(); total += blob.size
        if (blob.size > 20 * 1048576 || total > 100 * 1048576) throw new Error('单张图片限 20 MB，每次合计限 100 MB，请减少选择')
        if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) throw new Error('图片格式暂不支持加入对话')
        files.push(new File([blob], detail.name, { type: blob.type }))
      }
      if (signal && signal.aborted) throw new DOMException('操作已取消', 'AbortError')
      if (ctx.uiSession.current.getSnapshot().key !== sessionId || ctx.sessions.binding(sessionId) !== binding) throw new Error('当前对话已切换，请重新添加图片')
      var drafts = conversation.createDrafts(sessionId, files, true)
      if (!shell.addAttachments(drafts.map(function (draft) { return draft.id }))) {
        conversation.releaseDraftAttachments(drafts)
        throw new Error('对话正在提交，请稍后重新添加图片')
      }
      ctx.layout.selectPanel(null)
      shell.focus()
      return drafts.length
    }
    function ConversationButton(props) {
      var bs = useState(false), busy = bs[0], setBusy = bs[1], es = useState(''), error = es[0], setError = es[1]
      var lock = useRef(false), controller = useRef()
      useEffect(function () { return function () { if (controller.current) controller.current.abort() } }, [])
      return h('span', null, h('button', { disabled: busy || !props.chat || !props.ids.length, onClick: async function () {
        if (lock.current) return
        lock.current = true; setBusy(true); setError(''); controller.current = new AbortController()
        try { await props.chat(props.ids.slice(), controller.current.signal) }
        catch (e) { if (e.name !== 'AbortError') setError(e.message) }
        finally { lock.current = false; if (!controller.current.signal.aborted) setBusy(false) }
      } }, busy ? '正在添加图片…' : '添加到对话'), error ? h('span', { role: 'alert' }, error) : null)
    }
    async function attachLora(ctx, id, signal) {
      var sessionId = ctx.uiSession.current.getSnapshot().key, binding = sessionId && ctx.sessions.binding(sessionId)
      if (!binding) throw new Error('请先打开一个对话，再进入 LoRA 库')
      if (binding.session.getSnapshot().subagent !== null) throw new Error('请切换到普通对话后添加 LoRA')
      var shell = ctx.conversation.input.for(binding.ctx), actions = shell.actions
      if (!actions || !actions.captureInsertion || !actions.insertText) throw new Error('当前 DSH 版本缺少草稿文字插入接口，可先复制 LoRA 信息')
      var span = actions.captureInsertion(), item = await request('loras/item', { id: id }, signal)
      if (signal && signal.aborted) throw new DOMException('操作已取消', 'AbortError')
      if (ctx.uiSession.current.getSnapshot().key !== sessionId || ctx.sessions.binding(sessionId) !== binding) throw new Error('当前对话已切换，请重新添加 LoRA')
      if (!actions.insertText('\n' + item.context + '\n', span)) throw new Error('对话草稿已变化或正在提交，请重新点击添加 LoRA')
      ctx.layout.selectPanel(null); shell.focus()
    }
    function LoraDetail(props) {
      var item = props.item, cs = useState(item.categories.join(', ')), categories = cs[0], setCategories = cs[1], ns = useState(item.note || ''), note = ns[0], setNote = ns[1]
      var bs = useState(false), busy = bs[0], setBusy = bs[1], es = useState(''), error = es[0], setError = es[1], ms = useState(''), message = ms[0], setMessage = ms[1]
      var mounted = useRef(true), lock = useRef(false), controller = useRef()
      useEffect(function () { mounted.current = true; return function () { mounted.current = false; if (controller.current) controller.current.abort() } }, [])
      async function run(kind) {
        if (lock.current) return
        lock.current = true; setBusy(true); setError(''); setMessage(''); controller.current = new AbortController()
        try {
          if (kind === 'chat') await props.chat(item.id, controller.current.signal)
          else if (kind === 'fetch') { await compute('loras/fetch', { id: item.id }, props.token); if (mounted.current) setMessage('正在后台抓取资料与预览…') }
          else { await compute('loras/annotation', { id: item.id, patch: { categories: categories.split(/[,，\n]/).map(function (v) { return v.trim() }).filter(Boolean), note: note } }, props.token); if (mounted.current) setMessage('分类与备注已保存') }
          if (mounted.current && kind !== 'chat') props.changed()
        } catch (e) { if (mounted.current && e.name !== 'AbortError') setError(e.message) }
        finally { lock.current = false; if (mounted.current) setBusy(false) }
      }
      var working = item.fetch && item.fetch.state === 'running'
      return h('div', { className: 'cg-detail-body' }, h('h2', null, item.displayName), h('p', { className: 'cg-caption cg-muted' }, item.name + ' · ' + bytes(item.size)),
        item.preview ? h('img', { className: 'cg-original', src: endpoint('loras/thumb', { id: item.id, v: item.fetch && item.fetch.completedAt || item.mtime }), alt: item.displayName }) : h('div', { className: 'cg-empty' }, '暂无本地预览图'),
        h('div', { className: 'cg-actions cg-detail-actions' }, h('button', { className: 'cg-primary', disabled: busy || !props.chat, onClick: function () { run('chat') } }, '添加 LoRA 到对话'), h(CopyButton, { value: item.context, label: 'LoRA 信息' }),
          h('button', { disabled: busy || working || props.batchWorking || !props.token, onClick: function () { run('fetch') } }, working ? '正在抓取…' : '抓取预览与资料')),
        h('p', { className: 'cg-muted cg-caption' }, '将使用信息加入当前对话草稿，由你发送。'),
        error ? h('p', { role: 'alert' }, error) : null, message ? h('p', { role: 'status' }, message) : null,
        item.fetch ? h('p', { role: item.fetch.error ? 'alert' : 'status', className: 'cg-muted' }, item.fetch.error || item.fetch.warning || item.fetch.stage) : null,
        h('section', { className: 'cg-section' }, h('h3', null, '分类与收藏'), h('button', { disabled: busy || !props.token, onClick: function () { props.favorite(item) } }, item.favorite ? '★ 已收藏' : '☆ 收藏 LoRA'),
          h('div', { className: 'cg-form' }, h('label', null, '自定义分类（逗号分隔，可添加多个）', h('input', { value: categories, maxLength: 2400, onChange: function (e) { setCategories(e.target.value) } })),
            h('label', null, '备注', h('textarea', { rows: 3, value: note, maxLength: 4000, onChange: function (e) { setNote(e.target.value) } })),
            h('button', { disabled: busy || !props.token, onClick: function () { run('save') } }, '保存分类与备注'))),
        h(Field, { label: '底模', value: item.base + '（' + item.baseSource + '）' }), h(Field, { label: '文件路径', value: item.path }), h(Field, { label: '相对路径', value: item.relativePath }),
        h(Field, { label: '版本', value: item.version || '未记录' }), h(Field, { label: '作者', value: item.creator || '未记录' }), h(Field, { label: '触发词', value: item.triggers.join(', ') || '未记录' }),
        h(Field, { label: '来源标签', value: item.tags.join(', ') || '未记录' }), h(Field, { label: '资料来源', value: item.metadataSources.join('、') || '文件信息' }),
        item.description ? h(Prompt, { label: '模型说明', value: item.description }) : null, item.notes ? h(Prompt, { label: '已有本地备注', value: item.notes }) : null,
        h('section', { className: 'cg-section' }, h('h3', null, '训练信息'), Object.keys(item.training).map(function (key) { var labels = { network: '网络类型', dim: 'Dim', alpha: 'Alpha', resolution: '训练尺寸', epochs: 'Epoch', steps: 'Steps', trainingModel: '训练模型' }; return item.training[key] ? h(Field, { key: key, label: labels[key], value: item.training[key] }) : null }),
          h('p', { className: 'cg-muted' }, item.tensorCount ? item.tensorCount + ' 个张量 · 仅解析文件头，未加载模型权重' : '此文件未提供可读的 Safetensors 文件头')),
        item.trainingTags.length ? h('details', null, h('summary', null, '训练标签频次（前 100 项，供参考）'), h('div', { className: 'cg-score-list' }, item.trainingTags.map(function (tag) { return h('div', { key: tag.tag }, h('span', null, tag.tag), h('span', null, tag.count)) }))) : null,
        item.metadataError ? h('p', { role: 'alert' }, item.metadataError) : null,
        h('details', null, h('summary', null, '原始文件头元数据'), h(CopyButton, { value: JSON.stringify(item.metadata, null, 2), label: '文件头元数据' }), h('pre', { className: 'cg-raw' }, JSON.stringify(item.metadata, null, 2))))
    }
    function LoraFetchStatus(props) {
      var job = props.job
      if (!job) return null
      var working = job.state === 'running' || job.state === 'cancelling'
      var labels = { running: '正在抓取 LoRA 资料', cancelling: '正在取消…', cancelled: '已取消抓取', done: 'LoRA 抓取完成', error: '抓取已暂停', interrupted: '上次抓取已中断' }
      return h('section', { className: 'cg-fetch-status', 'aria-label': 'LoRA 抓取进度' },
        h('div', { className: 'cg-section-head' }, h('strong', { role: 'status' }, labels[job.state] || job.state), h('span', { className: 'cg-muted' }, job.completed + ' / ' + job.total),
          working ? h('button', { disabled: props.busy || job.state === 'cancelling', onClick: props.cancel }, '取消抓取') : null,
          h('button', { type: 'button', onClick: props.close, 'aria-label': '关闭抓取进度' }, '关闭')),
        h('progress', { value: job.completed, max: Math.max(1, job.total), 'aria-label': 'LoRA 抓取进度' }),
        h('p', { className: 'cg-muted' }, '成功 ' + job.succeeded + ' · 已齐全跳过 ' + job.skipped + ' · 失败 ' + job.failed + (working ? ' · 切回对话后继续运行' : '')),
        job.current ? h('p', { className: 'cg-fetch-current' }, job.current.name + ' · ' + job.stage) : null,
        job.error ? h('p', { role: 'alert' }, job.error) : null,
        job.errors && job.errors.length ? h('details', null, h('summary', null, '查看失败明细（' + job.failed + '）'), job.errors.map(function (row, i) { return h('p', { key: i, className: 'cg-caption' }, row.name + '：' + row.error) }), job.failed > job.errors.length ? h('p', null, '仅显示前 100 条失败记录') : null) : null)
    }
    function LoraPanel(props) {
      var qs = useState(''), query = qs[0], setQuery = qs[1], fs = useState({ folder: '', base: '', category: '', tags: '', favorite: '', missing: '', sort: 'name' }), filters = fs[0], setFilters = fs[1]
      var os = useState(0), offset = os[0], setOffset = os[1], rs = useState(0), revision = rs[0], setRevision = rs[1], ls = useState(null), list = ls[0], setList = ls[1]
      var ss = useState(''), selected = ss[0], setSelected = ss[1], ds = useState(null), detail = ds[0], setDetail = ds[1], es = useState(''), error = es[0], setError = es[1], bs = useState(false), busy = bs[0], setBusy = bs[1]
      var js = useState(null), job = js[0], setJob = js[1], sc = useState('filtered'), scope = sc[0], setScope = sc[1], fm = useState('missing'), mode = fm[0], setMode = fm[1]
      var hs = useState(false), dismissed = hs[0], setDismissed = hs[1]
      var pending = useRef(new Set()), mounted = useRef(true), batchLock = useRef(false), seen = useRef(''), listSeen = useRef(''), batchVersion = useRef(0)
      var working = job && (job.state === 'running' || job.state === 'cancelling')
      useEffect(function () { mounted.current = true; return function () { mounted.current = false } }, [])
      useEffect(function () { if (list && offset && offset >= list.total) setOffset(Math.max(0, Math.ceil(list.total / 40) - 1) * 40) }, [list && list.total, offset])
      function changed() { setRevision(function (n) { return n + 1 }) }
      function filter(key, value) { setFilters(function (old) { return Object.assign({}, old, { [key]: value }) }); setOffset(0) }
      function reset() { setQuery(''); setFilters({ folder: '', base: '', category: '', tags: '', favorite: '', missing: '', sort: 'name' }); setOffset(0) }
      var selectedTags = filters.tags ? JSON.parse(filters.tags) : []
      function toggleTag(tag) {
        var key = tag.trim().toLowerCase(), found = selectedTags.some(function (value) { return value.toLowerCase() === key })
        var next = found ? selectedTags.filter(function (value) { return value.toLowerCase() !== key }) : selectedTags.length < 30 ? selectedTags.concat([tag]) : selectedTags
        filter('tags', next.length ? JSON.stringify(next) : '')
      }
      useEffect(function () {
        var controller = new AbortController(), timer
        function poll() { request('loras', Object.assign({ q: query, offset: offset, limit: 40 }, filters), controller.signal).then(function (value) { setList(value); setError(''); if (value.scanning) timer = setTimeout(poll, 1500) }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }) }
        timer = setTimeout(poll, 180); return function () { controller.abort(); clearTimeout(timer) }
      }, [query, JSON.stringify(filters), offset, revision])
      useEffect(function () {
        var controller = new AbortController(), timer
        function poll() {
          var version = batchVersion.current
          request('loras/batch', {}, controller.signal).then(function (value) {
            if (version !== batchVersion.current || controller.signal.aborted) { timer = setTimeout(poll, 1500); return }
            setJob(value)
            var fingerprint = value ? value.id + ':' + value.completed + ':' + value.state : ''
            if (fingerprint !== seen.current) { seen.current = fingerprint; changed() }
            timer = setTimeout(poll, value && (value.state === 'running' || value.state === 'cancelling') ? 1500 : 5000)
          }).catch(function (e) { if (e.name !== 'AbortError') { setError(e.message); timer = setTimeout(poll, 5000) } })
        }
        poll(); return function () { controller.abort(); clearTimeout(timer) }
      }, [])
      useEffect(function () {
        setDetail(function (old) { return old && old.id === selected ? old : null }); if (!selected) return
        var controller = new AbortController(), timer
        function poll() { request('loras/item', { id: selected }, controller.signal).then(function (value) {
          setDetail(value)
          var stamp = value.fetch && value.fetch.completedAt
          if (stamp && listSeen.current !== selected + ':' + stamp) { listSeen.current = selected + ':' + stamp; changed() }
          if (value.fetch && value.fetch.state === 'running' || working) timer = setTimeout(poll, 1500)
        }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }) }
        poll(); return function () { controller.abort(); clearTimeout(timer) }
      }, [selected, revision, !!working])
      async function favorite(item) {
        if (pending.current.has(item.id)) return
        pending.current.add(item.id)
        try { await compute('loras/annotation', { id: item.id, patch: { favorite: !item.favorite } }, props.token); if (mounted.current) changed() }
        catch (e) { if (mounted.current) setError(e.message) }
        finally { pending.current.delete(item.id) }
      }
      async function refresh() {
        if (batchLock.current) return
        batchLock.current = true; setBusy(true)
        try { await compute('loras/refresh', {}, props.token); if (mounted.current) changed() } catch (e) { if (mounted.current) setError(e.message) }
        finally { batchLock.current = false; if (mounted.current) setBusy(false) }
      }
      async function fetchAll(cancel) {
        if (batchLock.current) return
        if (!cancel) setDismissed(false)
        batchLock.current = true; batchVersion.current++; setBusy(true); setError('')
        try {
          var value = await compute(cancel ? 'loras/batch/cancel' : 'loras/batch/start', cancel ? {} : { mode: mode, filters: scope === 'all' ? {} : Object.assign({ q: query }, filters) }, props.token)
          if (mounted.current) { setJob(value); changed() }
        } catch (e) { if (mounted.current) setError(e.message) }
        finally { batchLock.current = false; if (mounted.current) setBusy(false) }
      }
      function select(key, label, values) { return h('select', { 'aria-label': label, value: filters[key], onChange: function (e) { filter(key, e.target.value) } }, h('option', { value: '' }, label), values.map(function (value) { return h('option', { key: value, value: value }, value) })) }
      var activeFilters = query || filters.folder || filters.base || filters.category || filters.tags || filters.favorite || filters.missing
      var tagLabels = { action: '动作', animal: '动物', assets: '素材', background: '背景', 'base model': '基础模型', buildings: '建筑', celebrity: '名人', character: '角色', clothing: '服装', concept: '概念', objects: '物体', poses: '姿势', style: '风格', tool: '工具', vehicle: '车辆', anime: '动漫', realistic: '写实', fantasy: '奇幻', landscape: '风景', portrait: '肖像', nsfw: '成人内容' }
      var presetTags = ['Action', 'Animal', 'Assets', 'Background', 'Base Model', 'Buildings', 'Celebrity', 'Character', 'Clothing', 'Concept', 'Objects', 'Poses', 'Style', 'Tool', 'Vehicle']
      function tagText(tag) { var label = tagLabels[tag.toLowerCase()]; return label ? label + ' ' + tag : tag }
      var availableTags = list && list.tags || []
      return h('div', { className: 'cg-lora-page' }, h('div', { className: 'cg-toolbar' },
        h('div', { className: 'cg-heading' }, h('div', null, h('h2', null, '本地 LoRA 库')), h('span', { role: 'status', className: 'cg-count' }, list ? list.total + ' / ' + list.indexed + ' 个' + (list.scanning ? ' · 索引中' : '') : '正在读取…')),
        h('div', { className: 'cg-filters' }, h('input', { type: 'search', 'aria-label': '搜索 LoRA', placeholder: '搜索名称、触发词、分类、备注…', value: query, onChange: function (e) { setQuery(e.target.value); setOffset(0) } }),
          select('folder', '全部目录', list ? list.folders : []), select('base', '全部底模', list ? list.bases : []), select('category', '全部分类', list ? list.categories : [])),
        h('details', { className: 'cg-category-filter', open: selectedTags.length ? true : undefined },
          h('summary', null, '来源标签' + (selectedTags.length ? ' · 已选 ' + selectedTags.length : '')),
          h('p', { className: 'cg-muted cg-tag-note' }, '按来源标签筛选，选择多个时匹配任一标签。未标注的模型需要先补全资料。'),
          h('div', { className: 'cg-category-chips' }, presetTags.map(function (tag) {
            var entry = availableTags.find(function (item) { return item.name.toLowerCase() === tag.toLowerCase() }), active = selectedTags.some(function (value) { return value.toLowerCase() === tag.toLowerCase() })
            return h('button', { type: 'button', key: tag, 'aria-pressed': active, onClick: function () { toggleTag(tag) } }, tagText(tag) + ' · ' + (entry ? entry.count : 0))
          })),
          h('label', { className: 'cg-tag-select' }, '其他来源标签', h('select', { 'aria-label': '选择其他来源标签', value: '', onChange: function (event) { if (event.target.value) toggleTag(event.target.value) } },
            h('option', { value: '' }, '选择标签…'), availableTags.filter(function (entry) { return !presetTags.some(function (tag) { return tag.toLowerCase() === entry.name.toLowerCase() }) }).map(function (entry) { return h('option', { key: entry.name, value: entry.name }, tagText(entry.name) + ' · ' + entry.count) }))),
          selectedTags.length ? h('div', { className: 'cg-category-chips' }, selectedTags.map(function (tag) { return h('button', { type: 'button', key: tag, 'aria-label': '移除标签 ' + tagText(tag), 'aria-pressed': true, onClick: function () { toggleTag(tag) } }, tagText(tag) + ' ×') }), h('button', { type: 'button', onClick: function () { filter('tags', '') } }, '清除标签')) : null),
        h('div', { className: 'cg-quick-filters' }, h('button', { 'aria-pressed': filters.favorite === '1', onClick: function () { filter('favorite', filters.favorite ? '' : '1') } }, '★ 收藏'),
          h('button', { 'aria-pressed': filters.missing === '1', onClick: function () { filter('missing', filters.missing ? '' : '1') } }, '待补全资料'),
          h('select', { 'aria-label': 'LoRA 排序', value: filters.sort, onChange: function (e) { filter('sort', e.target.value) } }, h('option', { value: 'name' }, '按名称'), h('option', { value: 'date' }, '最新在前')),
          activeFilters ? h('button', { onClick: reset }, '清除筛选') : null, h('button', { disabled: busy || working || list && list.scanning || !props.token, onClick: refresh }, '刷新目录')),
        h('details', { className: 'cg-fetch-fold', open: working ? true : undefined },
          h('summary', null, '资料补全 · 元数据与预览图' + (working ? ' · 进行中' : '')),
          h('div', { className: 'cg-fetch-controls', 'aria-label': '一键抓取 LoRA 资料' },
            h('div', { className: 'cg-fetch-description' }, h('span', { className: 'cg-muted' }, '从公开源补全元数据与预览图，缓存在本机')),
            h('select', { 'aria-label': '抓取范围', disabled: working || busy, value: scope, onChange: function (e) { setScope(e.target.value) } }, h('option', { value: 'filtered' }, '当前筛选（' + (list ? list.total : '…') + ' 个）'), h('option', { value: 'all' }, '全部 LoRA（' + (list ? list.indexed : '…') + ' 个）')),
            h('select', { 'aria-label': '抓取模式', disabled: working || busy, value: mode, onChange: function (e) { setMode(e.target.value) } }, h('option', { value: 'missing' }, '仅补全缺失'), h('option', { value: 'all' }, '重新抓取全部')),
            h('button', { className: 'cg-primary', disabled: busy || working || !props.token || !list || list.scanning || !(scope === 'all' ? list.indexed : list.total), onClick: function () { fetchAll(false) } }, working ? '后台抓取中…' : '一键抓取'))),
        dismissed && job ? h('button', { type: 'button', className: 'cg-fetch-reopen', onClick: function () { setDismissed(false) } }, working ? '显示抓取进度' : '查看抓取结果') : h(LoraFetchStatus, { job: job, busy: busy, cancel: function () { fetchAll(true) }, close: function () { setDismissed(true) } }),
        list && !list.roots.length ? h('p', { className: 'cg-notice' }, '尚未找到 LoRA 目录，请在图库配置中设置 loraRoots，或配置 comfyRoot。') : null,
        error || list && list.error ? h('p', { role: 'alert' }, error || list.error) : null),
        h('div', { className: 'cg-layout' + (selected ? ' cg-selected' : '') }, h('section', { className: 'cg-browser', 'aria-label': 'LoRA 列表' },
          list && !list.items.length ? h('div', { className: 'cg-empty' }, h('div', null, h('strong', null, list.scanning ? '正在读取本地模型资料…' : '没有匹配的 LoRA'), activeFilters ? h('button', { onClick: reset }, '清除筛选查看全部') : null)) : null,
          h('div', { className: 'cg-grid' }, list ? list.items.map(function (row) { return h('article', { key: row.id, className: 'cg-card' + (selected === row.id ? ' cg-active' : '') },
            h('button', { className: 'cg-image-button', onClick: function () { setSelected(row.id) }, 'aria-label': '查看 LoRA ' + row.displayName }, row.preview ? h('img', { loading: 'lazy', decoding: 'async', className: 'cg-thumb', src: endpoint('loras/thumb', { id: row.id, v: row.previewVersion || row.mtime }), alt: row.displayName }) : h('div', { className: 'cg-thumb cg-broken' }, h('span', { className: 'cg-placeholder-mark', 'aria-hidden': true }, 'L'), h('span', null, '暂无预览图')),
              h('div', { className: 'cg-card-copy' }, h('strong', { title: row.displayName }, row.displayName), h('span', { className: 'cg-badge' }, row.base), h('p', { className: 'cg-excerpt cg-muted' }, row.categories.join('、') || row.folder || '未分类'))),
            h('div', { className: 'cg-card-actions' }, h('span', { className: 'cg-muted', title: row.onlineMetadata && row.preview ? '已有公开资料与预览' : '可一键补全资料' }, row.onlineMetadata && row.preview ? '资料齐全' : '待补全'), h('button', { disabled: !props.token, 'aria-label': row.favorite ? '取消收藏 LoRA' : '收藏 LoRA', 'aria-pressed': !!row.favorite, onClick: function () { favorite(row) } }, row.favorite ? '★' : '☆'))) }) : null),
          list ? h('div', { className: 'cg-pagination' }, h('button', { disabled: offset === 0, onClick: function () { setOffset(Math.max(0, offset - 40)) } }, '上一页'), h('span', { className: 'cg-muted' }, list.total ? Math.floor(offset / 40) + 1 + ' / ' + Math.ceil(list.total / 40) : '0 / 0'), h('button', { disabled: offset + 40 >= list.total, onClick: function () { setOffset(offset + 40) } }, '下一页')) : null),
          selected ? h('aside', { className: 'cg-detail', 'aria-label': 'LoRA 详情' }, h('div', { className: 'cg-detail-nav' }, h('button', { onClick: function () { setSelected('') } }, '← 返回 LoRA 列表'), h('span', { className: 'cg-muted' }, 'LoRA 详情')), detail ? h(LoraDetail, { key: detail.id, item: detail, token: props.token, changed: changed, favorite: favorite, chat: props.chat, revision: revision, batchWorking: working }) : h('p', { role: 'status', className: 'cg-notice' }, '正在读取 LoRA 元数据…')) : null))
    }

    function UploadPanel(props) {
      var ss = useState(null), source = ss[0], setSource = ss[1], bs = useState(false), busy = bs[0], setBusy = bs[1], es = useState(''), error = es[0], setError = es[1]
      var active = useRef(null), mounted = useRef(true), lock = useRef(false)
      async function release(item, remove) {
        if (!item) return
        await compute(remove ? 'interrogate/upload/remove' : 'interrogate/upload/release', { id: item.id }, props.token)
        if (item.preview && item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview)
        if (remove) interrogationSessions.delete(item.id)
      }
      useEffect(function () {
        mounted.current = true
        var controller = new AbortController()
        request('interrogate/upload/current', props.id ? { id: props.id } : {}, controller.signal).then(function (value) {
          if (!mounted.current || !value || active.current || lock.current) return
          if (value.job) interrogationSessions.set(value.id, value.job)
          var next = Object.assign({}, value, { preview: endpoint('interrogate/upload/file', { id: value.id }) })
          active.current = next; setSource(next)
        }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) })
        return function () { mounted.current = false; controller.abort(); var item = active.current; if (item && item.preview && item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview); active.current = null }
      }, [])
      async function choose(file) {
        if (!file || lock.current) return
        lock.current = true; setBusy(true); setError('')
        try {
          if (!file.size || file.size > 20 * 1048576) throw new Error('请选择 20 MB 以内的图片')
          var response = await fetch(API + 'interrogate/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-gallery-token': props.token, 'x-gallery-name': encodeURIComponent(file.name) }, body: file })
          var value = await response.json()
          if (!response.ok) throw new Error(value.error || '图片上传失败')
          var next = Object.assign({}, value, { name: file.name, preview: URL.createObjectURL(file) })
          if (!mounted.current) { URL.revokeObjectURL(next.preview); return }
          var previous = active.current; active.current = next; setSource(next); if (previous) await release(previous, false)
        } catch (e) { if (mounted.current) setError(e.message) }
        finally { lock.current = false; if (mounted.current) setBusy(false) }
      }
      return h('div', { className: 'cg-feature-page' }, h('h2', null, '上传图片反推'),
        h('p', { className: 'cg-muted' }, '切回会话后反推会在后台继续，可从“反推记录”查看进度和结果。支持 PNG、JPEG、WebP、GIF，单张限 20 MB、4000 万像素；动图读取第一帧。上传图片会保留供再次查看，最多 20 张、合计 100 MB，可删除旧记录释放空间。'),
        h('label', { className: 'cg-form' }, source ? '更换图片' : '选择图片', h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', disabled: busy, onChange: function (e) { var file = e.target.files[0]; e.target.value = ''; choose(file) } })),
        busy ? h('p', { role: 'status' }, '正在上传并检查图片…') : null,
        error ? h('p', { role: 'alert' }, error) : null,
        source ? h('div', null, h('img', { src: source.preview, alt: source.name, className: 'cg-original' }), h('p', { className: 'cg-caption' }, source.name + ' · ' + source.width + ' × ' + source.height + ' · ' + bytes(source.size)),
          h('button', { disabled: busy, onClick: async function () { try { await release(active.current, true); active.current = null; setSource(null) } catch (e) { setError(e.message) } } }, '移除图片及其反推记录'),
          h(Interrogate, { key: source.id, id: source.id, expanded: true, downloadName: source.name, saved: props.saved, openSaved: props.open })) : null)
    }
    function HistoryPanel(props) {
      var hs = useState(null), history = hs[0], setHistory = hs[1], qs = useState(''), query = qs[0], setQuery = qs[1], fs = useState(''), filter = fs[0], setFilter = fs[1]
      var os = useState(0), offset = os[0], setOffset = os[1], ss = useState(''), selected = ss[0], setSelected = ss[1], js = useState(null), job = js[0], setJob = js[1]
      var es = useState(''), error = es[0], setError = es[1], bs = useState(false), busy = bs[0], setBusy = bs[1], rs = useState(0), revision = rs[0], setRevision = rs[1]
      var mounted = useRef(true), lock = useRef(false)
      var states = { queued: '排队中', running: '后台反推中', done: '已完成', error: '失败／已中断', cancelled: '已取消' }
      useEffect(function () { mounted.current = true; return function () { mounted.current = false } }, [])
      useEffect(function () {
        var controller = new AbortController(), timer
        function poll() { request('interrogate/history', { q: query, state: filter, offset: offset, limit: 20 }, controller.signal).then(function (value) { setHistory(value); timer = setTimeout(poll, 2000) }).catch(function (e) { if (e.name !== 'AbortError') { setError(e.message); timer = setTimeout(poll, 4000) } }) }
        poll(); return function () { controller.abort(); clearTimeout(timer) }
      }, [query, filter, offset, revision])
      useEffect(function () {
        setJob(null); if (!selected) return
        var controller = new AbortController(), timer
        function poll() { request('interrogate/job', { id: selected }, controller.signal).then(function (value) { setJob(value); if (value.state === 'running' || value.state === 'queued') timer = setTimeout(poll, 1000) }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }) }
        poll(); return function () { controller.abort(); clearTimeout(timer) }
      }, [selected, revision])
      async function action(row, remove) {
        if (lock.current) return
        lock.current = true; setBusy(true); setError('')
        try {
          await compute(remove ? 'interrogate/history/remove' : 'interrogate/cancel', { jobId: row.jobId }, props.token)
          if (mounted.current) { if (remove && selected === row.jobId) { setSelected(''); setJob(null) }; if (remove) { interrogationSessions.delete(row.imageId); setOffset(0) }; setRevision(function (n) { return n + 1 }) }
        } catch (e) { if (mounted.current) setError(e.message) }
        finally { lock.current = false; if (mounted.current) setBusy(false) }
      }
      return h('div', { className: 'cg-feature-page' }, h('h2', null, '反推记录'),
        h('p', { className: 'cg-muted' }, '切回会话或关闭图库面板后继续后台运行。保留最近 100 条单张及批量反推记录，结果写入本地；退出 DSH 会中断未完成任务，可从记录重新打开。删除记录会清理不再被其他记录使用的上传图片，已入库图片会保留。'),
        h('div', { className: 'cg-filters' }, h('input', { type: 'search', 'aria-label': '搜索反推记录', value: query, placeholder: '搜索图片名、提示词、模型…', onChange: function (e) { setQuery(e.target.value); setOffset(0) } }),
          h('select', { 'aria-label': '反推状态', value: filter, onChange: function (e) { setFilter(e.target.value); setOffset(0) } }, h('option', { value: '' }, '全部状态'), Object.keys(states).map(function (state) { return h('option', { key: state, value: state }, states[state]) })),
          h('button', { onClick: function () { setRevision(function (n) { return n + 1 }) } }, '刷新记录')),
        history ? h('p', { role: 'status', className: 'cg-muted' }, history.total + ' 条记录 · 后台任务 ' + history.running + ' 个') : h('p', { role: 'status' }, '正在读取记录…'),
        error || history && history.error ? h('p', { role: 'alert' }, error || history.error) : null,
        history && !history.items.length ? h('p', null, '暂无匹配的反推记录。') : null,
        history ? history.items.map(function (row) {
          var working = row.state === 'queued' || row.state === 'running', uploaded = row.imageId.startsWith('upload:')
          return h('section', { className: 'cg-section', key: row.jobId }, h('div', { className: 'cg-section-head' }, h('strong', null, row.name), h('span', { className: 'cg-muted' }, states[row.state])),
            h('p', { className: 'cg-muted' }, date(row.createdAt) + ' · ' + row.model + ' · ' + (uploaded ? '上传图片' : '图库图片')),
            row.excerpt ? h('p', { className: 'cg-excerpt' }, row.excerpt) : null,
            row.error ? h('p', { className: 'cg-muted' }, row.error) : null,
            h('div', { className: 'cg-actions' }, h('button', { onClick: function () { setSelected(row.jobId) } }, selected === row.jobId ? '正在查看' : '查看结果'),
              row.sourceAvailable ? h('button', { onClick: function () { uploaded ? props.resume(row.imageId) : props.open(row.imageId) } }, uploaded ? '打开图片／重新反推' : '在图库中查看') : h('span', { className: 'cg-muted' }, '原图已移除，记录文本仍保留'),
              h('button', { disabled: busy, onClick: function () { action(row, !working) } }, working ? '取消任务' : '删除记录')),
            selected === row.jobId && job ? h('div', null,
              row.sourceAvailable ? h('img', { className: 'cg-original', alt: row.name, src: endpoint(uploaded ? 'interrogate/upload/file' : 'file', { id: row.imageId }) }) : null,
              job.result ? h('div', null, h('div', { className: 'cg-actions' }, h(CopyButton, { value: job.result.text, label: '反推提示词' }), h('button', { onClick: function () { download(row.name.replace(/\.[^.]+$/, '') + '.txt', job.result.text, 'text/plain;charset=utf-8') } }, '下载 caption')),
                h('pre', { className: 'cg-prompt', tabIndex: 0 }, job.result.text || '本次未识别到标签'),
                h('p', { className: 'cg-muted' }, '阈值 ' + job.options.threshold + ' / ' + job.options.characterThreshold + ' · ' + job.result.tags.length + ' 个标签'),
                uploaded && row.sourceAvailable && job.state === 'done' ? h(SaveToGallery, { key: job.jobId, id: row.imageId, jobId: job.jobId, name: row.name, token: props.token, saved: props.saved, open: props.open, savedImport: job.savedImport }) : null) : h('p', { role: 'status' }, states[job.state])) : null)
        }) : null,
        history ? h('div', { className: 'cg-actions' }, h('button', { disabled: offset === 0, onClick: function () { setOffset(Math.max(0, offset - 20)) } }, '上一页'), h('button', { disabled: offset + 20 >= history.total, onClick: function () { setOffset(offset + 20) } }, '下一页')) : null)
    }
    function SaveToGallery(props) {
      var bs = useState(false), busy = bs[0], setBusy = bs[1], ss = useState(props.savedImport || null), saved = ss[0], setSaved = ss[1], es = useState(''), error = es[0], setError = es[1]
      var lock = useRef(false), mounted = useRef(true)
      useEffect(function () { mounted.current = true; return function () { mounted.current = false } }, [])
      async function save() {
        if (lock.current || saved) return
        lock.current = true; setBusy(true); setError('')
        try {
          var value = await compute('interrogate/upload/save', { id: props.id, jobId: props.jobId, name: props.name }, props.token)
          if (mounted.current) { setSaved(value); if (props.saved) props.saved() }
        } catch (e) { if (mounted.current) setError(e.message) }
        finally { lock.current = false; if (mounted.current) setBusy(false) }
      }
      return h('div', null, h('div', { className: 'cg-actions' },
        h('button', { type: 'button', disabled: busy || !!saved || !props.token, onClick: save }, busy ? '正在保存…' : saved ? '已保存到图库' : '保存到图库'),
        saved && props.open ? h('button', { type: 'button', onClick: function () { props.open(saved.id) } }, '在图库中查看') : null),
        saved ? h('p', { role: 'status', className: 'cg-muted' }, '已保存至“图库导入”，包含图片和提示词文本。' + (saved.firstFrame ? 'GIF 已保存为第一帧 PNG。' : '')) : null,
        error ? h('p', { role: 'alert' }, error) : null)
    }
    function Interrogate(props) {
      var os = useState(!!props.expanded), open = os[0], setOpen = os[1]
      var ts = useState(null), tools = ts[0], setTools = ts[1]
      var ms = useState(''), model = ms[0], setModel = ms[1]
      var ps = useState({ threshold: 0.35, characterThreshold: 0.85, excludeTags: '', sortAlpha: false, replaceUnderscore: true, escapeBrackets: true, includeConfidence: false }), options = ps[0], setOptions = ps[1]
      var js = useState(function () { return interrogationSessions.get(props.id) || null }), job = js[0], setJob = js[1]
      var es = useState(''), error = es[0], setError = es[1]
      var bs = useState(false), busy = bs[0], setBusy = bs[1]
      var rs = useState(0), reloadTools = rs[0], setReloadTools = rs[1]
      var mounted = useRef(true), submitting = useRef(false), restore = useRef()
      useEffect(function () { mounted.current = true; return function () { mounted.current = false } }, [])
      function update(value) {
        interrogationSessions.delete(props.id); interrogationSessions.set(props.id, value)
        if (interrogationSessions.size > 100) interrogationSessions.delete(interrogationSessions.keys().next().value)
        if (mounted.current) setJob(value)
      }
      useEffect(function () {
        if (!open) return
        var controller = new AbortController(); restore.current = controller
        request('interrogate/latest', { id: props.id }, controller.signal).then(function (value) { if (value && !submitting.current) { update(value); if (value.options) setOptions(value.options); if (value.modelId) setModel(value.modelId) } }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) })
        return function () { controller.abort() }
      }, [open, props.id])
      useEffect(function () {
        if (!open) return
        var controller = new AbortController()
        setError('')
        request('interrogate/tools', {}, controller.signal).then(function (value) {
          setTools(value)
          var models = value.tools[0].models
          setModel(function (selected) { return models.some(function (m) { return m.id === selected }) ? selected : models.length ? models[0].id : '' })
        }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) })
        return function () { controller.abort() }
      }, [open, reloadTools])
      var working = job && (job.state === 'queued' || job.state === 'running')
      useEffect(function () {
        if (!working) return
        var controller = new AbortController(), timer
        function poll() {
          request('interrogate/job', { id: job.jobId }, controller.signal).then(function (value) {
            update(value); setError('')
            if (value.state === 'queued' || value.state === 'running') timer = setTimeout(poll, 1000)
          }).catch(function (e) {
            if (e.name === 'AbortError') return
            setError(e.message)
            if (e.status === 404) update(Object.assign({}, job, { state: 'error', error: e.message }))
            else timer = setTimeout(poll, 2500)
          })
        }
        timer = setTimeout(poll, 500)
        return function () { clearTimeout(timer); controller.abort() }
      }, [job && job.jobId, !!working])
      function option(key, value) { setOptions(function (old) { var next = Object.assign({}, old); next[key] = value; return next }) }
      async function action(cancel) {
        if (submitting.current) return
        if (restore.current) restore.current.abort()
        submitting.current = true; setBusy(true); setError('')
        try { update(await compute(cancel ? 'interrogate/cancel' : 'interrogate', cancel ? { jobId: job.jobId } : { id: props.id, tool: 'wd14', model: model, options: options }, tools.token)) }
        catch (e) { if (mounted.current) setError(e.message) }
        finally { submitting.current = false; if (mounted.current) setBusy(false) }
      }
      var tool = tools && tools.tools[0], result = job && job.result
      return h('section', { className: 'cg-section' }, h('details', { open: open, onToggle: function (e) { setOpen(e.currentTarget.open) } },
        h('summary', null, '提示词反推 · 本地 WD14'),
        h('p', { className: 'cg-muted cg-interrogate-note' }, '根据画面识别标签，与图片中保存的原始提示词分别显示。使用 CPU，不占用生图显存。'),
        !tools ? h('p', { role: 'status', className: 'cg-muted' }, '正在检查本地工具…') : h('div', { className: 'cg-interrogate-controls' },
          h('label', null, '反推模型', h('select', { value: model, disabled: busy || working, onChange: function (e) { setModel(e.target.value) } },
            tool.models.length ? tool.models.map(function (m) { return h('option', { key: m.id, value: m.id }, m.name) }) : h('option', { value: '' }, '未找到本地模型'))),
          !tool.ready ? h('p', { className: 'cg-muted' }, tool.reason) : null,
          h('div', { className: 'cg-interrogate-numbers' }, [['threshold', '普通标签阈值'], ['characterThreshold', '角色标签阈值']].map(function (row) {
            return h('label', { key: row[0] }, row[1], h('input', { type: 'number', min: 0, max: 1, step: 0.01, value: options[row[0]], disabled: busy || working,
              onChange: function (e) { option(row[0], e.target.value === '' ? '' : Number(e.target.value)) } }))
          })),
          h('label', null, '排除标签（逗号分隔）', h('input', { type: 'text', value: options.excludeTags, maxLength: 4096, disabled: busy || working, placeholder: '例如：watermark, text', onChange: function (e) { option('excludeTags', e.target.value) } })),
          h('div', { className: 'cg-actions' }, [['replaceUnderscore', '下划线转空格'], ['escapeBrackets', '括号转义'], ['sortAlpha', '按字母排序'], ['includeConfidence', '附带置信度权重']].map(function (row) {
            return h('label', { key: row[0], className: 'cg-check' }, h('input', { type: 'checkbox', checked: options[row[0]], disabled: busy || working, onChange: function (e) { option(row[0], e.target.checked) } }), row[1])
          })),
          h('div', { className: 'cg-actions' }, h('button', { type: 'button', disabled: !tool.ready || !model || busy || working, onClick: function () { action(false) } }, busy ? '正在提交…' : result ? '重新反推' : '开始反推'),
            h('button', { type: 'button', disabled: busy || working, onClick: function () { setReloadTools(function (n) { return n + 1 }) } }, '重新检测工具'),
            working ? h('button', { type: 'button', disabled: busy, onClick: function () { action(true) } }, '取消任务') : null)),
        job ? h('p', { role: 'status', className: 'cg-muted cg-interrogate-note' }, ({ queued: '已排队，等待前一张完成', running: '正在本地反推，首次加载模型可能较慢…', cancelled: '已取消', error: '反推失败', done: job.cached ? '已读取缓存结果' : '反推完成' })[job.state]) : null,
        error || job && job.error ? h('p', { role: 'alert', className: 'cg-notice' }, error || job.error) : null,
        result ? h('div', null, h('div', { className: 'cg-section-head' }, h('strong', null, '反推结果 · ' + result.tags.length + ' 个标签'), h('div', { className: 'cg-actions' }, h(CopyButton, { value: result.text, label: '反推提示词' }), props.downloadName ? h('button', { onClick: function () { download(props.downloadName.replace(/\.[^.]+$/, '') + '.txt', result.text, 'text/plain;charset=utf-8') } }, '下载 caption') : null)),
          h('p', { className: 'cg-muted' }, job.model + ' · 阈值 ' + job.options.threshold + ' / ' + job.options.characterThreshold + ' · ' + result.elapsedSec + ' 秒 · CPU'),
          h('pre', { className: 'cg-prompt', tabIndex: 0 }, result.text || '当前阈值下未识别到标签，可降低阈值重试。'),
          props.downloadName && job.state === 'done' ? h(SaveToGallery, { key: job.jobId, id: props.id, jobId: job.jobId, name: props.downloadName, token: tools && tools.token, saved: props.saved, open: props.openSaved, savedImport: job.savedImport }) : null,
          h('details', null, h('summary', null, '标签置信度（最多显示 200 项）'), h('div', { className: 'cg-score-list' }, result.tags.slice(0, 200).map(function (tag) {
            return h('div', { key: tag.tag }, h('span', null, tag.tag), h('span', null, (tag.confidence * 100).toFixed(1) + '%'))
          }))), h('details', null, h('summary', null, '内容分级评分'), result.ratings.map(function (rating) { return h(Field, { key: rating.tag, label: rating.tag, value: (rating.confidence * 100).toFixed(1) + '%' }) }))) : null))
    }
    function ImageViewer(props) {
      var dialog = useRef(null)
      useEffect(function () {
        var element = dialog.current
        if (element && !element.open) element.showModal()
        return function () { if (element && element.open) element.close() }
      }, [])
      return h('dialog', { ref: dialog, className: 'cg-image-viewer', 'aria-label': '查看大图：' + props.item.name, onCancel: function (event) { event.preventDefault(); props.close() }, onClick: function (event) { if (event.target === event.currentTarget) props.close() } },
        h('div', { className: 'cg-viewer-bar' }, h('strong', { title: props.item.name }, props.item.name), h('button', { type: 'button', autoFocus: true, onClick: props.close, 'aria-label': '关闭大图' }, '关闭 ✕')),
        h('div', { className: 'cg-viewer-image' }, h('img', { src: endpoint('file', { id: props.item.id }), alt: props.item.name, decoding: 'async' })))
    }
    function allPromptParameters(data) {
      var parameters = {
        '采样参数': data.sampling || {},
        '图片尺寸': { width: data.width, height: data.height },
        'Latent 尺寸与批次': data.sizeNote || {},
        '模型': data.models || {},
        'LoRA 与权重': data.loras || [],
        '全部采样节点': data.samplingChains || []
      }
      return '正向提示词：\n' + (data.positive || '') + '\n\n负向提示词：\n' + (data.negative || '') + '\n\n生成参数（仅包含图片中已记录的信息）：\n' + JSON.stringify(parameters, null, 2)
    }
    function Detail(props) {
      var data = props.item, sampling = data.sampling || {}, size = data.sizeNote || {}
      var models = data.models || {}, labels = { checkpoint: 'Checkpoint', unet: 'UNet', clip: 'CLIP', vae: 'VAE', other: '其他模型' }
      var vs = useState(false), viewing = vs[0], setViewing = vs[1]
      return h('div', { className: 'cg-detail-body' },
        h('div', { className: 'cg-section-head' }, h('h2', null, data.name), h(CopyButton, { value: JSON.stringify(data, null, 2), label: '全部参数' })),
        h('a', { href: endpoint('file', { id: data.id }), target: '_blank', rel: 'noreferrer', title: '打开原图', className: 'cg-original-link' },
          h('img', { className: 'cg-original', src: endpoint('file', { id: data.id }), alt: data.name, decoding: 'async' })),
        h('div', { className: 'cg-muted cg-caption' }, date(data.mtime) + ' · ' + bytes(data.size) + ' · ' + (data.width && data.height ? data.width + ' × ' + data.height : '尺寸未记录')),
        h('div', { className: 'cg-actions' }, h('button', { type: 'button', onClick: function () { setViewing(true) } }, '查看大图'),
          props.remove ? h(DeleteButton, { label: '删除这张图片', confirm: '删除这张图片', onConfirm: props.remove }) : null),
        viewing ? h(ImageViewer, { item: data, close: function () { setViewing(false) } }) : null,
        h(ConversationButton, { chat: props.chat, ids: [data.id] }),
        data.hasMetadata ? null : h('p', { className: 'cg-notice' }, '这张图片未保存 ComfyUI 元数据。仍可查看原图和文件信息。'),
        h(Prompt, { label: '正向提示词', value: data.positive, allText: allPromptParameters(data) }), h(Prompt, { label: '负向提示词', value: data.negative }),
        h(MarkEditor, { key: 'mark-' + data.id, id: data.id, token: props.token, changed: props.changed }),
        h('section', { className: 'cg-section' }, h('button', { disabled: !props.token, onClick: props.reuse }, '带入参数复用工作台')),
        h(Interrogate, { key: data.id, id: data.id }),
        h('section', { className: 'cg-section' }, h('h3', null, '采样参数'),
          h('div', { className: 'cg-fields' }, [['Seed', sampling.seed], ['Steps', sampling.steps], ['CFG', sampling.cfg], ['Sampler', sampling.samplerName], ['Scheduler', sampling.scheduler], ['Denoise', sampling.denoise], ['真实尺寸', data.width && data.height ? data.width + ' × ' + data.height : undefined], ['Latent 尺寸', size.width && size.height ? size.width + ' × ' + size.height : undefined], ['Batch', size.batch]].map(function (row) { return h(Field, { key: row[0], label: row[0], value: row[1] }) })),
          data.samplingChains && data.samplingChains.length > 1 ? h('details', null, h('summary', null, '全部采样节点（' + data.samplingChains.length + '）'), data.samplingChains.map(function (chain) {
            return h('div', { key: chain.node, className: 'cg-node' }, h('strong', null, '#' + chain.node + ' ' + chain.title), h(CopyButton, { value: JSON.stringify(chain, null, 2), label: '采样节点' }), h('pre', null, JSON.stringify(chain, null, 2)))
          })) : null),
        h('section', { className: 'cg-section' }, h('h3', null, '模型'), Object.keys(labels).map(function (key) {
          return (models[key] || []).map(function (name) { return h(Field, { key: key + name, label: labels[key], value: name }) })
        }), Object.values(models).every(function (list) { return !list.length }) ? h('p', { className: 'cg-muted' }, '未记录模型') : null),
        h('section', { className: 'cg-section' }, h('h3', null, 'LoRA'), (data.loras || []).length ? data.loras.map(function (lora, index) {
          return h('div', { key: index, className: 'cg-lora' }, h(Field, { label: '名称', value: lora.name }), h(Field, { label: '模型权重', value: lora.strength }), h(Field, { label: 'CLIP 权重', value: lora.strengthClip }))
        }) : h('p', { className: 'cg-muted' }, '未记录 LoRA')),
        h('section', { className: 'cg-section' }, h('details', null, h('summary', null, '节点概览（' + (data.nodes || []).length + '）'),
          (data.groups || []).length ? h(Field, { label: '分组', value: data.groups.join(' / ') }) : null,
          (data.nodes || []).map(function (node) { return h('div', { className: 'cg-node', key: node.id }, h('strong', null, '#' + node.id + ' ' + node.title), h('div', { className: 'cg-muted' }, node.type), h('pre', null, node.values.join('\n')), h(CopyButton, { value: JSON.stringify(node, null, 2), label: '节点' })) }))),
        h(RawData, { key: data.id, id: data.id }), h('section', { className: 'cg-section' }, h(Field, { label: '文件路径', value: data.path })))
    }
    var batchSession = null
    function download(name, content, type) {
      var url = URL.createObjectURL(new Blob([content], { type: type || 'application/octet-stream' }))
      var link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove()
      setTimeout(function () { URL.revokeObjectURL(url) }, 30000)
    }
    // Store captions in an ordinary ZIP, with UTF-8 filenames and no dependency on a library.
    function captionZip(files) {
      var encoder = new TextEncoder(), parts = [], directory = [], offset = 0
      function record(size) { var bytes = new Uint8Array(size); return { bytes: bytes, view: new DataView(bytes.buffer) } }
      files.forEach(function (file) {
        var name = encoder.encode(file.folder + '/' + file.name), data = encoder.encode(file.text), crc = 0xffffffff
        data.forEach(function (b) { crc ^= b; for (var i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }); crc = (crc ^ 0xffffffff) >>> 0
        var local = record(30), central = record(46), a = local.view, b = central.view
        a.setUint32(0, 0x04034b50, true); a.setUint16(4, 20, true); a.setUint16(6, 0x800, true); a.setUint32(14, crc, true); a.setUint32(18, data.length, true); a.setUint32(22, data.length, true); a.setUint16(26, name.length, true)
        b.setUint32(0, 0x02014b50, true); b.setUint16(4, 20, true); b.setUint16(6, 20, true); b.setUint16(8, 0x800, true); b.setUint32(16, crc, true); b.setUint32(20, data.length, true); b.setUint32(24, data.length, true); b.setUint16(28, name.length, true); b.setUint32(42, offset, true)
        parts.push(local.bytes, name, data); directory.push(central.bytes, name); offset += 30 + name.length + data.length
      })
      var length = directory.reduce(function (n, p) { return n + p.length }, 0), end = record(22)
      end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, files.length, true); end.view.setUint16(10, files.length, true); end.view.setUint32(12, length, true); end.view.setUint32(16, offset, true)
      return new Blob(parts.concat(directory, [end.bytes]), { type: 'application/zip' })
    }
    async function exportCaptions(ids, token) {
      var value = await compute('captions', { ids: ids }, token)
      if (!value.files.length) throw new Error('所选图片还没有已保存的反推结果')
      value.files.push({ folder: 'index', name: 'manifest.json', text: JSON.stringify({ files: value.files.map(function (f) { return { imageId: f.id, caption: f.folder + '/' + f.name } }), skipped: value.skipped }, null, 2) })
      download('gallery-captions.zip', captionZip(value.files), 'application/zip')
      return '已导出 ' + (value.files.length - 1) + ' 份 caption；跳过 ' + value.skipped.length + ' 张未反推图片'
    }
    function MarkEditor(props) {
      var vs = useState(null), value = vs[0], setValue = vs[1], es = useState(''), error = es[0], setError = es[1], bs = useState(false), busy = bs[0], setBusy = bs[1]
      var gs = useState(null), generated = gs[0], setGenerated = gs[1], dirty = useRef(new Set())
      useEffect(function () { var c = new AbortController(); request('annotation', { id: props.id }, c.signal).then(function (v) { setValue({ favorite: !!v.favorite, rating: v.rating || 0, tags: (v.tags || []).join(', '), note: v.note || '' }); setGenerated(v.generated) }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }); return function () { c.abort() } }, [props.id])
      function change(key, v) { dirty.current.add(key); setValue(function (old) { return Object.assign({}, old, { [key]: v }) }); setError('') }
      async function save() {
        setBusy(true); setError('')
        try { var patch = {}; dirty.current.forEach(function (key) { patch[key] = key === 'tags' ? value.tags.split(/[,，\n]/).map(function (t) { return t.trim() }).filter(Boolean) : value[key] }); await compute('annotation', { id: props.id, patch: patch }, props.token); dirty.current.clear(); setError('已保存'); props.changed() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h('section', { className: 'cg-section' }, h('h3', null, '收藏与整理'), value ? h('div', { className: 'cg-form' },
        h('label', { className: 'cg-check' }, h('input', { type: 'checkbox', disabled: busy, checked: value.favorite, onChange: function (e) { change('favorite', e.target.checked) } }), '收藏'),
        h('label', null, '评分', h('select', { disabled: busy, value: value.rating, onChange: function (e) { change('rating', Number(e.target.value)) } }, [0, 1, 2, 3, 4, 5].map(function (n) { return h('option', { key: n, value: n }, n ? '★'.repeat(n) : '未评分') }))),
        h('label', null, '自定义标签（逗号分隔，最多 30 个）', h('input', { disabled: busy, value: value.tags, onChange: function (e) { change('tags', e.target.value) } })),
        h('label', null, '备注', h('textarea', { disabled: busy, value: value.note, maxLength: 4000, rows: 3, onChange: function (e) { change('note', e.target.value) } })),
        h('button', { disabled: busy || !props.token, onClick: save }, busy ? '保存中…' : '保存标记')) : null, error ? h('p', { role: 'status' }, error) : null, generated ? h(Prompt, { label: '已保存的反推标签', value: generated.text }) : null)
    }
    function Compare(props) {
      var ds = useState([]), details = ds[0], setDetails = ds[1], es = useState(''), error = es[0], setError = es[1], zs = useState(1), zoom = zs[0], setZoom = zs[1], panes = useRef([])
      useEffect(function () { var c = new AbortController(); Promise.all(props.ids.map(function (id) { return request('item', { id: id }, c.signal) })).then(setDetails).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }); return function () { c.abort() } }, [props.ids])
      function sync(event) {
        var source = event.currentTarget, x = source.scrollLeft / Math.max(1, source.scrollWidth - source.clientWidth), y = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight)
        panes.current.forEach(function (pane) { if (!pane || pane === source) return; var left = x * (pane.scrollWidth - pane.clientWidth), top = y * (pane.scrollHeight - pane.clientHeight); if (Math.abs(pane.scrollLeft - left) > 1) pane.scrollLeft = left; if (Math.abs(pane.scrollTop - top) > 1) pane.scrollTop = top })
      }
      var rows = [['正向提示词', function (d) { return d.positive }], ['负向提示词', function (d) { return d.negative }], ['尺寸', function (d) { return d.width + ' × ' + d.height }], ['模型', function (d) { return JSON.stringify(d.models) }], ['LoRA 与权重', function (d) { return JSON.stringify(d.loras) }]]
      ;['seed', 'steps', 'cfg', 'samplerName', 'scheduler', 'denoise'].forEach(function (key) { rows.push([key, function (d) { return d.sampling && d.sampling[key] }]) })
      return h('div', { className: 'cg-feature-page' }, h('h2', null, '图片对比'), h('label', null, '同步缩放 ', h('select', { value: zoom, onChange: function (e) { setZoom(Number(e.target.value)) } }, [1, 1.5, 2, 3, 4].map(function (n) { return h('option', { key: n, value: n }, n + '×') }))), h('p', { className: 'cg-muted' }, '拖动任意图片的滚动条可同步查看相同位置；有差异的参数会高亮。'),
        error ? h('p', { role: 'alert' }, error) : !details.length ? h('p', null, '正在读取…') : h('div', { className: 'cg-compare-table' }, h('div', { className: 'cg-compare-images', style: { gridTemplateColumns: 'repeat(' + details.length + ',minmax(240px,1fr))' } }, details.map(function (d, i) { return h('div', { key: d.id }, h('h3', null, d.name), h('div', { className: 'cg-zoom-pane', ref: function (el) { panes.current[i] = el }, onScroll: sync }, h('img', { src: endpoint('file', { id: d.id }), alt: d.name, style: { width: zoom * 100 + '%', maxWidth: 'none' } }))) })),
          h('table', null, h('thead', null, h('tr', null, h('th', null, '参数'), details.map(function (d) { return h('th', { key: d.id }, d.name) }))), h('tbody', null, rows.map(function (r) { var values = details.map(function (d) { return text(r[1](d)) }), differs = new Set(values).size > 1; return h('tr', { key: r[0], className: differs ? 'cg-difference' : '' }, h('th', null, r[0]), values.map(function (v, i) { return h('td', { key: i }, v) })) })))))
    }
    function ReusePanel(props) {
      var ds = useState(null), draft = ds[0], setDraft = ds[1], vs = useState({}), values = vs[0], setValues = vs[1], es = useState(''), error = es[0], setError = es[1], bs = useState(false), busy = bs[0], setBusy = bs[1], rs = useState(null), result = rs[0], setResult = rs[1], submitting = useRef(false)
      useEffect(function () { var alive = true; compute('reuse/prepare', { id: props.id }, props.token).then(function (d) { if (alive) setDraft(d) }).catch(function (e) { if (alive) setError(e.message) }); return function () { alive = false } }, [props.id, props.token])
      function body() { return { draftId: draft.draftId, edits: draft.fields.filter(function (f) { return Object.prototype.hasOwnProperty.call(values, f.node + ':' + f.key) }).map(function (f) { var v = values[f.node + ':' + f.key]; if (f.type === 'number') { if (v === '' || !Number.isFinite(Number(v))) throw new Error('请检查数值参数：' + f.label); v = Number(v) } return { node: f.node, key: f.key, value: v } }) } }
      async function action(kind) {
        if (submitting.current) return; submitting.current = true; setBusy(true); setError('')
        try {
          if (kind === 'workflow') download('workflow.json', await request('raw', { id: props.id, kind: 'workflow' }, undefined, true), 'application/json')
          else if (kind === 'export') download('prompt-api.json', JSON.stringify(await compute('reuse/export', body(), props.token), null, 2), 'application/json')
          else setResult(await compute('reuse/submit', body(), props.token))
        } catch (e) { setError(e.message) } finally { submitting.current = false; setBusy(false) }
      }
      return h('div', { className: 'cg-feature-page' }, h('h2', null, '参数复用工作台'), error ? h('p', { role: 'alert' }, error) : null, draft ? h('div', null, h('p', null, draft.name), h('p', { className: 'cg-muted' }, draft.note),
        h('div', { className: 'cg-actions' }, h(CopyButton, { value: JSON.stringify({ positive: draft.positive, negative: draft.negative, sampling: draft.sampling, models: draft.models, loras: draft.loras }, null, 2), label: '复用摘要' }), h('button', { disabled: busy, onClick: function () { action('workflow') } }, '下载原始界面工作流'), draft.hasGraph ? h('button', { disabled: busy, onClick: function () { action('export') } }, '下载编辑后的 API 工作流') : null),
        h('div', { className: 'cg-form' }, draft.fields.map(function (f) { var key = f.node + ':' + f.key, value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : f.value; return h('label', { key: key }, f.label, h(f.type === 'string' && /text|positive|negative/.test(f.key) ? 'textarea' : 'input', { value: value, rows: 4, disabled: busy || !!result, type: f.type === 'number' ? 'number' : 'text', step: 'any', onChange: function (e) { var v = e.target.value; setValues(function (old) { return Object.assign({}, old, { [key]: v }) }) } })) })),
        draft.hasGraph ? h('div', { className: 'cg-section' }, h('p', null, '点击提交会实际生成图片，使用原工作流中的模型、节点和输出设置。请先启动 ComfyUI。'), h('button', { disabled: busy || !!result, onClick: function () { action('submit') } }, busy ? '处理中…' : result ? '已提交生成' : '通过生成工作台提交'), result ? h('p', { role: 'status' }, '已进入队列：' + (result.promptId || result.status)) : null) : h(Prompt, { label: '正向提示词', value: draft.positive })) : h('p', null, '正在带入参数…'))
    }
    function BatchPanel(props) {
      var ts = useState(null), tools = ts[0], setTools = ts[1], ms = useState(''), model = ms[0], setModel = ms[1], os = useState({ threshold: .35, characterThreshold: .85, excludeTags: '', replaceUnderscore: true, escapeBrackets: true, sortAlpha: false, includeConfidence: false }), options = os[0], setOptions = os[1], js = useState(batchSession), job = js[0], setJob = js[1], es = useState(''), error = es[0], setError = es[1], bs = useState(false), busy = bs[0], setBusy = bs[1], lock = useRef(false)
      useEffect(function () { var c = new AbortController(); request('interrogate/tools', {}, c.signal).then(function (v) { setTools(v); setModel(v.tools[0].models[0] ? v.tools[0].models[0].id : '') }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }); return function () { c.abort() } }, [])
      var working = job && job.state === 'running'
      function update(j) { batchSession = j; setJob(j) }
      useEffect(function () { if (!working) return; var c = new AbortController(), timer; function poll() { request('batch/job', { id: job.id }, c.signal).then(function (j) { update(j); if (j.state === 'running') timer = setTimeout(poll, 800); else props.changed() }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }) } poll(); return function () { c.abort(); clearTimeout(timer) } }, [working, job && job.id])
      function option(k, v) { setOptions(function (old) { return Object.assign({}, old, { [k]: v }) }) }
      async function action(kind) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { if (kind === 'export') setError(await exportCaptions(job ? job.results.map(function (r) { return r.id }) : props.ids, props.token)); else update(await compute(kind === 'start' ? 'batch/start' : 'batch/cancel', kind === 'start' ? { ids: props.ids, model: model, options: options } : { jobId: job.id }, props.token)) } catch (e) { setError(e.message) } finally { lock.current = false; setBusy(false) } }
      var tool = tools && tools.tools[0]
      return h('div', { className: 'cg-feature-page' }, h('h2', null, '批量提示词反推'), h('p', null, '当前选择 ' + props.ids.length + ' 张，每批最多 200 张。结果会保存到图库供搜索，原图保持原样。'), tool ? h('div', { className: 'cg-form' }, !tool.ready ? h('p', null, tool.reason) : null,
        h('label', null, 'WD14 模型', h('select', { value: model, disabled: working || busy, onChange: function (e) { setModel(e.target.value) } }, tool.models.map(function (m) { return h('option', { key: m.id, value: m.id }, m.name) }))),
        h('div', { className: 'cg-interrogate-numbers' }, [['threshold', '普通标签阈值'], ['characterThreshold', '角色标签阈值']].map(function (r) { return h('label', { key: r[0] }, r[1], h('input', { type: 'number', min: 0, max: 1, step: .01, disabled: working || busy, value: options[r[0]], onChange: function (e) { option(r[0], e.target.value === '' ? '' : Number(e.target.value)) } })) })),
        h('label', null, '排除标签（逗号分隔）', h('input', { value: options.excludeTags, disabled: working || busy, maxLength: 4096, onChange: function (e) { option('excludeTags', e.target.value) } })),
        h('div', { className: 'cg-actions' }, [['replaceUnderscore', '下划线转空格'], ['escapeBrackets', '括号转义'], ['sortAlpha', '字母排序'], ['includeConfidence', '置信度权重']].map(function (r) { return h('label', { key: r[0], className: 'cg-check' }, h('input', { type: 'checkbox', checked: options[r[0]], disabled: working || busy, onChange: function (e) { option(r[0], e.target.checked) } }), r[1]) })),
        h('div', { className: 'cg-actions' }, h('button', { disabled: !tool.ready || !props.ids.length || working || busy, onClick: function () { action('start') } }, '开始批量反推'), working ? h('button', { disabled: busy, onClick: function () { action('cancel') } }, '取消任务') : null, h('button', { disabled: busy || !(job ? job.results.length : props.ids.length), onClick: function () { action('export') } }, '导出 caption ZIP'))) : null,
        job ? h('div', { role: 'status' }, h('p', null, ({ running: '反推中', done: '已完成', cancelled: '已取消', error: '任务失败' }[job.state] || job.state) + ' · ' + job.completed + '/' + job.total + ' · 成功 ' + job.results.length), job.error ? h('p', null, job.error) : null, job.errors.length ? h('details', null, h('summary', null, '失败项目（' + job.errors.length + '）'), job.errors.map(function (e) { return h('p', { key: e.id }, e.error) })) : null) : null, error ? h('p', { role: 'status' }, error) : null)
    }
    function SimilarPanel(props) {
      var ms = useState('phash'), mode = ms[0], setMode = ms[1], ls = useState('normal'), level = ls[0], setLevel = ls[1], ss = useState(props.ids.length ? 'selected' : 'all'), scope = ss[0], setScope = ss[1], js = useState(null), job = js[0], setJob = js[1], es = useState(''), error = es[0], setError = es[1], bs = useState(false), busy = bs[0], setBusy = bs[1], ps = useState(0), page = ps[0], setPage = ps[1], cs = useState({}), counts = cs[0], setCounts = cs[1], lock = useRef(false)
      var working = job && ['running', 'grouping'].includes(job.state)
      useEffect(function () { var c = new AbortController(), timer; function poll() { request('similarity/job', { offset: page * 20, limit: 20 }, c.signal).then(function (j) { setJob(j); if (['running', 'grouping'].includes(j.state)) timer = setTimeout(poll, 900) }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }) } poll(); return function () { c.abort(); clearTimeout(timer) } }, [page, working])
      async function action(cancel) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { setJob(await compute(cancel ? 'similarity/cancel' : 'similarity/start', cancel ? {} : { mode: mode, level: level, all: scope === 'all', ids: props.ids }, props.token)); if (!cancel) { setPage(0); setCounts({}) } } catch (e) { setError(e.message) } finally { lock.current = false; setBusy(false) } }
      function compareGroup(g) { props.compare(g.members.slice(0, 4).map(function (m) { return m.id })) }
      return h('div', { className: 'cg-feature-page' }, h('h2', null, '相似图分组'), h('p', { className: 'cg-muted' }, '指纹分组查找近似重复图片；内容分组使用本地 CLIP 模型在 CPU 上索引，首次处理全库可能较久。手动开始后才会加载模型，可随时取消，已有指纹会缓存。分组供人工比较。'),
        h('div', { className: 'cg-form' }, h('label', null, '范围', h('select', { value: scope, disabled: working || busy, onChange: function (e) { setScope(e.target.value) } }, h('option', { value: 'selected', disabled: !props.ids.length }, '已选图片（' + props.ids.length + '）'), h('option', { value: 'all' }, '全图库'))),
          h('label', null, '分组依据', h('select', { value: mode, disabled: working || busy, onChange: function (e) { setMode(e.target.value) } }, h('option', { value: 'phash' }, '视觉指纹 · 近似重复'), h('option', { value: 'semantic', disabled: !props.features.semantic.ready }, 'CLIP · 内容相似'))),
          !props.features.semantic.ready ? h('p', null, props.features.semantic.reason) : null,
          h('label', null, '相似程度', h('select', { value: level, disabled: working || busy, onChange: function (e) { setLevel(e.target.value) } }, h('option', { value: 'strict' }, '严格'), h('option', { value: 'normal' }, '标准'), h('option', { value: 'loose' }, '宽松'))),
          h('div', { className: 'cg-actions' }, h('button', { disabled: working || busy || scope === 'selected' && !props.ids.length, onClick: function () { action(false) } }, '开始分组'), working ? h('button', { disabled: busy, onClick: function () { action(true) } }, '取消任务') : null)),
        error ? h('p', { role: 'alert' }, error) : null, job ? h('div', null, h('p', { role: 'status' }, (job.message || job.state) + ' · ' + job.completed + '/' + job.total + ' · ' + (job.groupCount || 0) + ' 组'), job.error ? h('p', { role: 'alert' }, job.error) : null,
          job.errors.length ? h('details', null, h('summary', null, '读取异常（' + job.errors.length + '）'), job.errors.map(function (e, i) { return h('p', { key: i }, e.error) })) : null,
          job.groups.map(function (g, i) { var count = counts[g.representative] || 8; return h('section', { className: 'cg-section', key: g.representative }, h('div', { className: 'cg-section-head' }, h('h3', null, '第 ' + (page * 20 + i + 1) + ' 组 · ' + g.memberCount + ' 张'), h('button', { onClick: function () { compareGroup(g) } }, '对比前 ' + Math.min(4, g.members.length) + ' 张')), h('div', { className: 'cg-similar-grid' }, g.members.slice(0, count).map(function (m) { return h('div', { key: m.id }, h('button', { className: 'cg-image-button', onClick: function () { props.open(m.id) }, title: '查看详情' }, h('img', { className: 'cg-thumb', src: endpoint('thumb', { id: m.id }), loading: 'lazy', alt: '相似图片' })), h('label', { className: 'cg-check' }, h('input', { type: 'checkbox', checked: props.ids.includes(m.id), onChange: function () { props.toggle(m.id) } }), job.mode === 'phash' ? '差异位数 ' + m.score : '余弦相似度 ' + m.score)) })), count < g.members.length ? h('button', { onClick: function () { setCounts(function (old) { return Object.assign({}, old, { [g.representative]: count + 16 }) }) } }, '显示更多成员') : null, g.memberCount > 200 ? h('p', { className: 'cg-muted' }, '该组仅展示前 200 张；可选定更小范围重新分组。') : null) }),
          h('div', { className: 'cg-actions' }, h('button', { disabled: page === 0, onClick: function () { setPage(page - 1) } }, '上一页'), h('button', { disabled: (page + 1) * 20 >= (job.groupCount || 0), onClick: function () { setPage(page + 1) } }, '下一页'))) : null)
    }

    function Card(props) {
      var state = useState(false), failed = state[0], setFailed = state[1], item = props.item
      return h('div', { className: 'cg-card' + (props.active ? ' cg-active' : '') }, h('button', { type: 'button', className: 'cg-image-button', onClick: function () { props.select(item.id) }, title: item.name },
        failed ? h('span', { className: 'cg-thumb cg-broken' }, '缩略图读取失败 · 点击查看') : h('img', { className: 'cg-thumb', src: endpoint('thumb', { id: item.id, v: item.mtime }), loading: 'lazy', decoding: 'async', alt: item.name, onError: function () { setFailed(true) } }),
        h('div', { className: 'cg-card-copy' }, h('strong', null, item.name), h('time', { className: 'cg-muted', dateTime: new Date(item.mtime).toISOString() }, date(item.mtime)), h('p', { className: 'cg-excerpt cg-muted' }, item.excerpt || (item.hasMeta ? '已保存工作流参数' : '查看图片信息')))),
        h('div', { className: 'cg-card-actions' }, h('label', { className: 'cg-check', title: props.checked ? '取消选择' : '选择此图' }, h('input', { type: 'checkbox', checked: props.checked, onChange: function () { props.toggle(item.id) }, 'aria-label': '选择 ' + item.name }), h('span', { className: 'cg-check-label' }, props.checked ? '已选' : '选择')), h('div', { className: 'cg-card-right' }, h('button', { type: 'button', className: 'cg-fav', 'aria-label': (item.favorite ? '取消收藏 ' : '收藏 ') + item.name, 'aria-pressed': !!item.favorite, disabled: !props.token, onClick: function () { props.favorite(item) } }, item.favorite ? '★' : '☆'), item.rating ? h('span', { className: 'cg-rating', title: '评分' }, item.rating + ' 分') : null)))
    }
    function SkeletonGrid(props) {
      return h('div', { className: 'cg-grid cg-skeleton-grid', 'aria-hidden': 'true' }, Array.from({ length: props.count || 12 }, function (_, i) {
        return h('div', { key: i, className: 'cg-card cg-skeleton-card' }, h('div', { className: 'cg-skeleton-thumb' }), h('div', { className: 'cg-skeleton-copy' }, h('div', { className: 'cg-skeleton-line' }), h('div', { className: 'cg-skeleton-line cg-short' })))
      }))
    }
    function useInfiniteScroll(hasMore, loading, onMore) {
      var ref = useRef(null)
      useEffect(function () {
        if (!hasMore || loading || !ref.current || typeof IntersectionObserver === 'undefined') return
        var ob = new IntersectionObserver(function (entries) { if (entries[0].isIntersecting) onMore() }, { rootMargin: '400px' })
        ob.observe(ref.current)
        return function () { ob.disconnect() }
      }, [hasMore, loading, onMore])
      return ref
    }
    function GalleryBody(props) {
      var ss = useState(''), search = ss[0], setSearch = ss[1], qs = useState(''), query = qs[0], setQuery = qs[1], ds = useState(''), dir = ds[0], setDir = ds[1], so = useState('desc'), sort = so[0], setSort = so[1]
      var os = useState(0), offset = os[0], setOffset = os[1], ts = useState(0), revision = ts[0], setRevision = ts[1], is = useState([]), items = is[0], setItems = is[1], rs = useState(null), result = rs[0], setResult = rs[1]
      var ls = useState(false), loading = ls[0], setLoading = ls[1], rfs = useState(false), refreshing = rfs[0], setRefreshing = rfs[1], es = useState(''), error = es[0], setError = es[1], ses = useState(''), selected = ses[0], setSelected = ses[1]
      var its = useState(null), item = its[0], setItem = its[1], des = useState(''), detailError = des[0], setDetailError = des[1], fs = useState({ favorite: '', rating: '', tag: '', model: '', lora: '' }), filters = fs[0], setFilters = fs[1]
      var cs = useState([]), checked = cs[0], setChecked = cs[1], ps = useState(null), panel = ps[0], setPanel = ps[1], fts = useState(null), features = fts[0], setFeatures = fts[1], fas = useState(null), facets = fas[0], setFacets = fas[1], fb = useState(false), catalogBusy = fb[0], setCatalogBusy = fb[1]
      var refreshController = useRef(), filterKey = JSON.stringify(filters), favoritePending = useRef(new Set())
      function changed() { setOffset(0); setRevision(function (n) { return n + 1 }) }
      function toggle(id) { setChecked(function (old) { if (old.includes(id)) return old.filter(function (v) { return v !== id }); if (old.length >= 200) { setError('最多选择 200 张，请先清除部分选择'); return old } return old.concat([id]) }) }
      function filter(k, v) { setFilters(function (old) { return Object.assign({}, old, { [k]: v }) }); setOffset(0) }
      useEffect(function () { var c = new AbortController(); request('features', {}, c.signal).then(setFeatures).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }); return function () { c.abort() } }, [])
      useEffect(function () { var timer = setTimeout(function () { setQuery(search); setOffset(0) }, 300); return function () { clearTimeout(timer) } }, [search])
      useEffect(function () {
        var c = new AbortController(); setLoading(true); setError('')
        request('list', Object.assign({ q: query, dir: dir, sort: sort, offset: offset, limit: 60 }, filters), c.signal).then(function (d) { setResult(d); setItems(function (old) { return offset === 0 ? d.items : old.concat(d.items.filter(function (v) { return !old.some(function (p) { return p.id === v.id }) })) }) }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }).finally(function () { if (!c.signal.aborted) setLoading(false) }); return function () { c.abort() }
      }, [query, dir, sort, offset, revision, filterKey])
      useEffect(function () { if (!result || (!result.scanning && !result.warming) || offset !== 0) return; var timer = setTimeout(function () { setRevision(function (n) { return n + 1 }) }, 2000); return function () { clearTimeout(timer) } }, [result, offset])
      var indexing = facets && facets.index && facets.index.state === 'running'
      useEffect(function () { var c = new AbortController(), timer; function poll() { request('facets', {}, c.signal).then(function (f) { setFacets(f); if (f.index && f.index.state === 'running') timer = setTimeout(poll, 1200); else if (indexing) changed() }).catch(function (e) { if (e.name !== 'AbortError') setError(e.message) }) } poll(); return function () { c.abort(); clearTimeout(timer) } }, [revision, indexing])
      useEffect(function () { setItem(null); setDetailError(''); if (!selected) return; var c = new AbortController(); request('item', { id: selected }, c.signal).then(setItem).catch(function (e) { if (e.name !== 'AbortError') setDetailError(e.message) }); return function () { c.abort() } }, [selected])
      useEffect(function () { return function () { if (refreshController.current) refreshController.current.abort() } }, [])
      async function refresh() { if (refreshController.current) refreshController.current.abort(); var c = new AbortController(); refreshController.current = c; setRefreshing(true); setError(''); try { await request('refresh', {}, c.signal); changed() } catch (e) { if (e.name !== 'AbortError') setError(e.message) } finally { if (!c.signal.aborted) setRefreshing(false) } }
      async function favorite(entry) { if (favoritePending.current.has(entry.id)) return; favoritePending.current.add(entry.id); try { await compute('annotation', { id: entry.id, patch: { favorite: !entry.favorite } }, features.token); changed() } catch (e) { setError(e.message) } finally { favoritePending.current.delete(entry.id) } }
      async function catalog() { setCatalogBusy(true); try { await compute(indexing ? 'catalog/cancel' : 'catalog/start', {}, features.token); changed() } catch (e) { setError(e.message) } finally { setCatalogBusy(false) } }
      function compare(ids) { if (ids.length < 2 || ids.length > 4) { setError('请选择 2–4 张图片对比'); return } setPanel({ type: 'compare', ids: ids.slice() }) }
      async function removeImages(ids) {
        if (!features) throw new Error('图库扩展功能未启用')
        var value = await compute('delete', { ids: ids }, features.token)
        setSelected(function (old) { return ids.indexOf(old) >= 0 ? '' : old })
        setChecked(function (old) { return old.filter(function (id) { return ids.indexOf(id) < 0 }) })
        if (value.failed && value.failed.length) setError('已删除 ' + value.deleted.length + ' 张，' + value.failed.length + ' 张失败：' + value.failed[0].error)
        else setError(value.deleted.length ? '已删除 ' + value.deleted.length + ' 张图片' : '')
        changed()
        return value
      }
      function open(id) { setPanel(null); setSelected(id) }
      function selectFilter(k, label, values) { return h('select', { 'aria-label': label, value: filters[k], onChange: function (e) { filter(k, e.target.value) } }, h('option', { value: '' }, label), values.map(function (v) { return h('option', { key: v, value: v }, v) })) }
      var browsing = !panel, filterCount = Object.values(filters).filter(Boolean).length
      var moreRef = useInfiniteScroll(result && items.length < result.total, loading, function () { setOffset(items.length) })
      return h('div', { className: 'cg-root' },
        h('header', { className: 'cg-app-header' }, h('div', { className: 'cg-heading' }, h('div', null, h('h1', null, 'ComfyUI 图库'), h('p', { className: 'cg-subtitle' }, result ? result.total + ' 张图片' + (facets && facets.models && facets.models.length ? ' · ' + facets.models.length + ' 个模型' : '') + (checked.length ? ' · 已选 ' + checked.length + ' 张' : '') : '正在读取…')), browsing ? h('span', { className: 'cg-count', role: 'status' }, result ? result.total + ' 张' : '正在读取…') : null),
          h('nav', { className: 'cg-navigation', 'aria-label': '图库导航' }, h('button', { 'aria-current': browsing ? 'page' : undefined, onClick: function () { setPanel(null) } }, '图片'),
            h('button', { disabled: !features, 'aria-current': panel && panel.type === 'loras' ? 'page' : undefined, onClick: function () { setPanel({ type: 'loras' }) } }, 'LoRA 库'),
            h('button', { disabled: !features, 'aria-current': panel && panel.type === 'upload' ? 'page' : undefined, onClick: function () { setPanel({ type: 'upload' }) } }, '上传图片反推'),
            h('button', { disabled: !features, 'aria-current': panel && panel.type === 'history' ? 'page' : undefined, onClick: function () { setPanel({ type: 'history' }) } }, '反推记录'),
            h('button', { disabled: !features, 'aria-current': panel && panel.type === 'similar' ? 'page' : undefined, onClick: function () { setPanel({ type: 'similar' }) } }, '相似图分组'))),
        browsing ? h('section', { className: 'cg-toolbar', 'aria-label': '图片筛选' },
          h('div', { className: 'cg-filters' }, h('input', { type: 'search', placeholder: '搜索文件名、提示词、标签、备注…', 'aria-label': '搜索图库', value: search, onChange: function (e) { setSearch(e.target.value) } }),
            h('select', { 'aria-label': '子目录', value: dir, onChange: function (e) { setDir(e.target.value); setOffset(0) } }, h('option', { value: '' }, '全部子目录'), ((result && result.directories) || []).map(function (v) { return h('option', { key: v, value: v }, v) })),
            h('select', { 'aria-label': '排序', value: sort, onChange: function (e) { setSort(e.target.value); setOffset(0) } }, h('option', { value: 'desc' }, '最新在前'), h('option', { value: 'asc' }, '最早在前')), h('button', { onClick: refresh, disabled: refreshing }, refreshing ? '刷新中…' : '刷新')),
          h('details', { className: 'cg-extra-filters' }, h('summary', null, '更多筛选' + (filterCount ? ' · 已启用 ' + filterCount + ' 项' : ' · 评分 / 标签 / 模型 / LoRA')), h('div', { className: 'cg-filters' }, h('label', { className: 'cg-check' }, h('input', { type: 'checkbox', checked: filters.favorite === '1', onChange: function (e) { filter('favorite', e.target.checked ? '1' : '') } }), '只看收藏'), h('select', { 'aria-label': '最低评分', value: filters.rating, onChange: function (e) { filter('rating', e.target.value) } }, h('option', { value: '' }, '全部评分'), [1, 2, 3, 4, 5].map(function (n) { return h('option', { key: n, value: n }, n + ' 分及以上') })), selectFilter('tag', '全部标签', facets ? facets.tags : []), selectFilter('model', '全部模型', facets ? facets.models : []), selectFilter('lora', '全部 LoRA', facets ? facets.loras : [])),
            h('div', { className: 'cg-actions' }, h('span', { className: 'cg-muted', role: 'status' }, facets ? '参数索引 ' + facets.indexed + '/' + facets.total + (indexing ? ' · 正在索引 ' + facets.index.completed + '/' + facets.index.total : '') : '正在读取索引…'), h('button', { disabled: !features || catalogBusy, onClick: catalog }, indexing ? '暂停参数索引' : '补全全库参数索引'), h('button', { onClick: function () { setFilters({ favorite: '', rating: '', tag: '', model: '', lora: '' }); setOffset(0) } }, '清除筛选')), facets && facets.index && facets.index.errors ? h('p', null, '索引异常 ' + facets.index.errors + ' 张') : null)) : null,
        browsing ? h('div', { className: 'cg-selection-bar' }, h('span', { className: 'cg-muted' }, checked.length ? '已选 ' + checked.length + ' 张' : '选择卡片可添加到对话、对比或批量反推'),
          checked.length ? h(ConversationButton, { chat: props.chat, ids: checked }) : null,
          h('button', { disabled: !items.length, onClick: function () { setChecked(function (old) { return Array.from(new Set(old.concat(items.map(function (v) { return v.id })))).slice(0, 200) }) } }, '选择已加载图片'),
          checked.length ? h('button', { onClick: function () { setChecked([]) } }, '清空选择') : null,
          checked.length ? h('button', { disabled: checked.length < 2 || checked.length > 4, onClick: function () { compare(checked) } }, '对比') : null,
          checked.length ? h('button', { disabled: !features, onClick: function () { setPanel({ type: 'batch' }) } }, '批量反推') : null,
          checked.length ? h('button', { disabled: !features, onClick: async function () { try { setError(await exportCaptions(checked, features.token)) } catch (e) { setError(e.message) } } }, '导出 caption') : null,
          checked.length ? h(DeleteButton, { label: '删除所选', confirm: '删除所选 ' + checked.length + ' 张图片', disabled: !features, onConfirm: function () { return removeImages(checked) } }) : null) : null,
        error ? h('div', { className: 'cg-notice', role: 'status' }, error) : null,
        panel ? h('section', { className: 'cg-panel', 'aria-label': '图库工具' }, panel.type === 'loras' ? null : h('div', { className: 'cg-detail-nav' }, h('button', { onClick: function () { setPanel(null) } }, '← 返回图库')), panel.type === 'loras' ? h(LoraPanel, { token: features.token, chat: props.loraChat }) : panel.type === 'upload' ? h(UploadPanel, { key: panel.id || 'latest-upload', id: panel.id, token: features.token, saved: changed, open: open }) : panel.type === 'history' ? h(HistoryPanel, { token: features.token, saved: changed, open: open, resume: function (id) { setPanel({ type: 'upload', id: id }) } }) : panel.type === 'compare' ? h(Compare, { ids: panel.ids }) : panel.type === 'reuse' ? h(ReusePanel, { key: panel.id, id: panel.id, token: features.token }) : panel.type === 'batch' ? h(BatchPanel, { ids: checked, token: features.token, changed: changed }) : h(SimilarPanel, { ids: checked, features: features, token: features.token, toggle: toggle, compare: compare, open: open })) :
        h('div', { className: 'cg-layout' + (selected ? ' cg-selected' : '') }, h('section', { className: 'cg-browser', 'aria-label': '图片列表', 'aria-busy': loading },
          result && (result.scanning || result.warming) ? h('p', { className: 'cg-muted cg-index-status', role: 'status' }, result.scanning ? '正在更新图片索引…' : '正在补全近期图片的提示词索引…') : null,
          !items.length && !loading ? h('div', { className: 'cg-empty' }, h('div', null, h('strong', null, result && result.scanning ? '正在查找图片…' : '没有匹配的图片'), !(result && result.scanning) ? h('p', null, '试试调整搜索或筛选条件。') : null, !(result && result.scanning) && (search || dir || filterCount) ? h('button', { onClick: function () { setSearch(''); setDir(''); setFilters({ favorite: '', rating: '', tag: '', model: '', lora: '' }); setOffset(0) } }, '清空全部筛选') : null)) : null,
          loading && !items.length ? h(SkeletonGrid, { count: 12 }) : null,
          h('div', { className: 'cg-grid' }, items.map(function (entry) { return h(Card, { key: entry.id + ':' + entry.mtime, item: entry, active: selected === entry.id, select: setSelected, checked: checked.includes(entry.id), toggle: toggle, favorite: favorite, token: features && features.token }) })), result && items.length < result.total ? h('div', { ref: moreRef, className: 'cg-more-wrap' }, h('button', { className: 'cg-more', disabled: loading, onClick: function () { setOffset(items.length) } }, loading ? '加载中…' : '加载更多（' + items.length + '/' + result.total + '）')) : null),
          selected ? h('aside', { className: 'cg-detail', 'aria-label': '图片详情' }, h('div', { className: 'cg-detail-nav' }, h('button', { onClick: function () { setSelected('') } }, '← 返回图库'), h('span', null, '图片详情')), detailError ? h('p', { className: 'cg-notice', role: 'alert' }, detailError) : item ? h(Detail, { key: item.id, item: item, chat: props.chat, token: features && features.token, changed: changed, reuse: function () { if (features) setPanel({ type: 'reuse', id: item.id }) }, remove: function () { return removeImages([item.id]) } }) : h('p', { className: 'cg-notice' }, '正在读取参数…')) : null))
    }

    function installStyles() {
      var existing = document.querySelector('style[data-plugin="dsh-comfyui-gallery"]')
      if (existing) return function () {}
      var style = document.createElement('style')
      style.dataset.plugin = 'dsh-comfyui-gallery'
      style.textContent = `.cg-panel:has(.cg-lora-page){display:flex;flex-direction:column;overflow:hidden}.cg-lora-page{display:flex;flex-direction:column;flex:1;min-height:0}.cg-panel>.cg-detail-nav{flex:none}.cg-root textarea{font:inherit;color:inherit;background:var(--cg-bg);border:1px solid var(--cg-border);border-radius:7px;padding:8px;resize:vertical;min-width:0}.cg-form{display:grid;gap:12px;margin:14px 0;max-width:980px}.cg-form>label{display:grid;gap:5px;overflow-wrap:anywhere}.cg-form>label.cg-check{display:flex}.cg-form input,.cg-form textarea,.cg-form select{width:100%}.cg-form .cg-check input{width:15px}.cg-panel{flex:1;min-height:0;overflow:auto}.cg-feature-page{padding:18px;display:grid;gap:14px}.cg-selection-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--cg-border);flex:none}.cg-selection-bar button{font-size:12px;padding:4px 8px}.cg-extra-filters{margin-top:8px}.cg-extra-filters .cg-actions{margin-top:10px;align-items:center}.cg-root .cg-card{border:1px solid var(--cg-border)}.cg-root .cg-image-button{padding:0;border:0;border-radius:0;text-align:left;width:100%;display:block}.cg-card-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;border-top:1px solid var(--cg-border)}.cg-card-actions button{padding:2px 8px}.cg-compare-table{overflow:auto}.cg-compare-images{display:grid;gap:10px}.cg-compare-images h3{height:44px;overflow-wrap:anywhere;overflow:hidden}.cg-zoom-pane{height:400px;overflow:auto;border:1px solid var(--cg-border)}.cg-zoom-pane img{display:block}.cg-compare-table table{border-collapse:collapse;width:100%;margin-top:16px;table-layout:fixed;min-width:650px}.cg-compare-table td,.cg-compare-table th{border:1px solid var(--cg-border);padding:8px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;font-size:12px}.cg-compare-table th:first-child{width:100px}.cg-difference{background:color-mix(in srgb,var(--cg-accent) 12%,transparent)}.cg-similar-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}

.cg-root{--cg-fg:var(--dsw-alias-label-primary,#0f1115);--cg-muted:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6));--cg-border:var(--dsw-alias-border-l2,rgba(15,17,21,.16));--cg-bg:var(--dsw-alias-bg-base,transparent);--cg-accent:var(--dsw-alias-state-business-primary,#4d93f8);color:var(--cg-fg);background:var(--cg-bg);font:13px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;height:100%;min-height:0;container-type:inline-size;overflow:hidden}
.cg-root *{box-sizing:border-box}.cg-root button,.cg-root input,.cg-root select{font:inherit;color:inherit;background:var(--cg-bg);border:1px solid var(--cg-border);border-radius:7px;padding:7px 10px;min-width:0}.cg-root button{cursor:pointer}.cg-root button:disabled{opacity:.55;cursor:default}.cg-root button:hover{border-color:var(--cg-accent)}.cg-root :focus-visible{outline:2px solid var(--cg-accent);outline-offset:2px}.cg-root h1,.cg-root h2,.cg-root h3,.cg-root p{margin:0}.cg-root h1{font-size:17px;font-weight:650}.cg-root h2{font-size:15px;overflow-wrap:anywhere;min-width:0}.cg-root h3{font-size:14px;font-weight:650}.cg-muted{color:var(--cg-muted)}.cg-toolbar{padding:16px;border-bottom:1px solid var(--cg-border);flex:none}.cg-heading,.cg-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.cg-filters{display:flex;gap:7px;flex-wrap:wrap}.cg-filters input{flex:1 1 200px;width:100%}.cg-filters select{max-width:45%;flex:1 1 100px}.cg-layout{flex:1;min-height:0;position:relative;display:flex}.cg-browser{flex:1;min-width:0;overflow:auto;padding:14px}.cg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px}.cg-root .cg-card{padding:0;text-align:left;overflow:hidden;display:block;width:100%;border-radius:10px}.cg-root .cg-active{border-color:var(--cg-accent);box-shadow:0 0 0 1px var(--cg-accent)}.cg-thumb{display:block;width:100%;aspect-ratio:4/3;object-fit:contain;background:color-mix(in srgb,var(--cg-fg) 4%,transparent)}.cg-broken{display:flex;align-items:center;text-align:center;padding:12px;font-size:11px;color:var(--cg-muted)}.cg-card-copy{padding:9px}.cg-card strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600}.cg-card time{display:block;font-size:10px;margin:5px 0}.cg-excerpt{font-size:11px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;min-height:33px;overflow-wrap:anywhere}.cg-root .cg-more{display:block;margin:18px auto 4px}.cg-empty{display:flex;align-items:center;justify-content:center;padding:50px 24px;min-height:160px;color:var(--cg-muted);text-align:center}.cg-index-status{padding:0 0 12px;font-size:12px}.cg-detail{min-width:0;flex:1;overflow:auto;background:var(--cg-bg)}.cg-detail-nav{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--cg-border)}.cg-detail-body{padding:16px}.cg-original-link{display:block}.cg-original{display:block;width:100%;max-height:400px;object-fit:contain;border-radius:8px;background:color-mix(in srgb,var(--cg-fg) 4%,transparent)}.cg-caption{font-size:11px;margin:8px 0 16px}.cg-section{padding:16px 0;border-top:1px solid var(--cg-border)}.cg-section>h3{margin-bottom:10px}.cg-root .cg-copy{font-size:11px;padding:4px 7px;flex:none}.cg-root summary{cursor:pointer;color:var(--cg-muted);font-size:12px;padding:4px 0}.cg-root pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace;margin:8px 0 0}.cg-prompt{font-size:14px;line-height:1.8;max-height:340px;overflow:auto;padding:12px;border:1px solid var(--cg-border);border-radius:7px;user-select:text}.cg-field{display:flex;align-items:start;gap:8px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--cg-border) 50%,transparent)}.cg-field>span:first-child{flex:0 0 86px;font-size:12px}.cg-value{flex:1;min-width:0;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace;font-size:12px;user-select:text}.cg-lora+.cg-lora{margin-top:14px}.cg-node{padding:12px 0;border-bottom:1px solid var(--cg-border);overflow-wrap:anywhere}.cg-node pre{font-size:11px}.cg-actions{display:flex;gap:8px;flex-wrap:wrap}.cg-raw{max-height:420px;overflow:auto;font-size:11px;padding:10px;border:1px solid var(--cg-border)}.cg-notice{padding:12px 16px;color:var(--cg-muted);overflow-wrap:anywhere}.cg-notice button{margin-left:10px}.cg-selected .cg-browser{display:none}
.cg-interrogate-note{margin:10px 0!important;font-size:12px}.cg-interrogate-controls{display:grid;gap:12px;margin:12px 0}.cg-interrogate-controls>label,.cg-interrogate-numbers label{display:grid;gap:5px;min-width:0}.cg-interrogate-controls select,.cg-interrogate-controls input[type=text]{width:100%}.cg-interrogate-numbers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.cg-check{display:flex;align-items:center;gap:5px;font-size:12px}.cg-root .cg-check input{margin:0;width:15px;height:15px;padding:0;accent-color:var(--cg-accent)}.cg-score-list{max-height:280px;overflow:auto}.cg-score-list>div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--cg-border);padding:5px 0}.cg-score-list span:first-child{overflow-wrap:anywhere}
@container(min-width:850px){.cg-selected .cg-browser{display:block;flex:0 0 46%;border-right:1px solid var(--cg-border)}.cg-selected .cg-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}
@container(max-width:360px){.cg-toolbar,.cg-browser,.cg-detail-body{padding:10px}.cg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cg-field>span:first-child{flex-basis:68px}.cg-filters select{max-width:100%}}

.cg-root{--cg-surface:color-mix(in srgb,var(--cg-fg) 3%,var(--cg-bg));--cg-soft:color-mix(in srgb,var(--cg-accent) 10%,transparent)}
.cg-app-header{padding:18px 20px 0;flex:none;border-bottom:1px solid var(--cg-border)}
.cg-app-header .cg-heading{margin-bottom:14px}.cg-root h1{font-size:19px;letter-spacing:-.35px}
.cg-root .cg-subtitle{font-size:11px;color:var(--cg-muted);margin-top:3px}
.cg-count{flex:none;font-size:11px;font-variant-numeric:tabular-nums;padding:4px 9px;border:1px solid var(--cg-border);border-radius:20px;color:var(--cg-muted)}
.cg-navigation{display:flex;gap:4px;overflow:auto;scrollbar-width:thin;padding-bottom:6px}
.cg-root .cg-navigation button{border:0;background:transparent;border-radius:7px;white-space:nowrap;flex:none;padding:8px 11px;color:var(--cg-muted);font-size:12px}
.cg-root .cg-navigation button[aria-current=page]{color:var(--cg-accent);background:var(--cg-soft);font-weight:650}
.cg-root .cg-navigation button:hover{background:var(--cg-surface);color:var(--cg-fg)}
.cg-toolbar{padding:14px 20px}.cg-root .cg-filters input[type=search]{flex:2 1 220px;padding-left:12px;background:var(--cg-surface)}
.cg-extra-filters{border-top:1px solid var(--cg-border);padding-top:7px;margin-top:10px}.cg-extra-filters>summary{list-style-position:inside}
.cg-selection-bar{padding:9px 20px;background:var(--cg-surface);gap:8px}.cg-selection-bar>span:first-child{font-size:11px;margin-right:auto}
.cg-root .cg-selection-bar button{border-color:transparent;background:var(--cg-bg)}
.cg-browser{padding:18px 20px;overscroll-behavior:contain;scrollbar-width:thin}.cg-grid{grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:16px;align-items:start}
.cg-root .cg-card{border-radius:12px;background:var(--cg-bg);transition:border-color .15s,box-shadow .15s}.cg-root .cg-card:hover{border-color:color-mix(in srgb,var(--cg-accent) 50%,var(--cg-border));box-shadow:0 3px 14px color-mix(in srgb,var(--cg-fg) 7%,transparent)}
.cg-root .cg-card.cg-active{border-color:var(--cg-accent);box-shadow:0 0 0 1px var(--cg-accent)}
.cg-thumb{aspect-ratio:1;object-fit:contain;background:var(--cg-surface)}.cg-card-copy{padding:10px 11px}.cg-card strong{font-size:12px}.cg-card time{margin:5px 0 7px}
.cg-card-actions{padding:6px 9px;min-height:35px}.cg-card-actions>span{font-size:10px}.cg-root .cg-card-actions button{border-color:transparent;font-size:16px;line-height:1.2}
.cg-root button[aria-pressed=true]{color:var(--cg-accent);border-color:var(--cg-accent);background:var(--cg-soft)}
.cg-root button.cg-primary{background:var(--cg-soft);border-color:color-mix(in srgb,var(--cg-accent) 60%,transparent);color:var(--cg-accent);font-weight:650}
.cg-detail-nav{position:sticky;top:0;z-index:2;background:var(--cg-bg);backdrop-filter:blur(12px)}.cg-detail-body{padding:20px}.cg-detail-actions{margin:14px 0 10px;position:sticky;top:54px;background:var(--cg-bg);padding:8px 0;z-index:1}
.cg-detail .cg-original{max-height:440px}.cg-root .cg-section{margin-top:14px}.cg-root .cg-field{padding:10px 0}.cg-root .cg-section-head{margin-bottom:10px}
.cg-empty{min-height:200px;line-height:1.8}.cg-empty strong{display:block;font-size:14px;font-weight:600}.cg-empty p{font-size:12px}.cg-empty button{margin-top:14px}
.cg-badge{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;padding:2px 7px;border-radius:5px;background:var(--cg-soft);color:var(--cg-accent);margin:7px 0 5px}
.cg-broken{flex-direction:column;justify-content:center;gap:8px}.cg-placeholder-mark{font-size:30px;font-weight:300;opacity:.35}
.cg-quick-filters{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px}.cg-root .cg-quick-filters button,.cg-root .cg-quick-filters select{font-size:11px;padding:5px 9px}
.cg-fetch-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px;margin-top:12px;background:var(--cg-surface);border:1px solid var(--cg-border);border-radius:10px}
.cg-fetch-description{display:flex;flex:1 1 170px;flex-direction:column;font-size:12px;gap:2px}.cg-fetch-description span{font-size:10px}.cg-fetch-controls select{flex:1 1 140px;max-width:100%;font-size:11px}
.cg-fetch-controls>.cg-primary{flex:none}.cg-fetch-status{margin-top:10px;border:1px solid var(--cg-border);border-radius:10px;padding:12px;font-size:11px}.cg-fetch-status .cg-section-head{flex-wrap:wrap;gap:6px}.cg-fetch-status strong{font-weight:600}.cg-fetch-status button{font-size:11px;padding:3px 8px}
.cg-fetch-status progress{display:block;width:100%;height:5px;margin:8px 0 10px;accent-color:var(--cg-accent)}.cg-fetch-current{overflow-wrap:anywhere;margin-top:5px!important}.cg-fetch-status details{max-height:150px;overflow:auto;margin-top:8px}.cg-fetch-status details p{overflow-wrap:anywhere}
.cg-pagination{display:flex;justify-content:center;align-items:center;gap:14px;margin:22px 0 4px;font-size:11px}.cg-root .cg-pagination button{font-size:11px}
.cg-category-filter{margin-top:10px;border-top:1px solid var(--cg-border);padding-top:6px}.cg-tag-note{font-size:11px;margin:6px 0!important}.cg-category-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.cg-root .cg-category-chips button{border-radius:999px;font-size:11px;padding:5px 10px}.cg-tag-select{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:11px}.cg-tag-select select{max-width:100%;flex:1 1 150px}
.cg-image-viewer{position:fixed;inset:0;width:min(96vw,1600px);height:94vh;max-width:none;max-height:none;padding:0;border:1px solid #50545c;border-radius:12px;background:#17191c;color:#fff;overflow:hidden}.cg-image-viewer::backdrop{background:rgba(0,0,0,.86)}.cg-viewer-bar{height:54px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;background:#202228}.cg-viewer-bar strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cg-image-viewer .cg-viewer-bar button{color:#fff;background:#30343b;border:1px solid #6d717a;border-radius:7px;padding:7px 12px;cursor:pointer}.cg-viewer-image{height:calc(100% - 54px);display:flex;align-items:center;justify-content:center;padding:10px}.cg-viewer-image img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
.cg-lora-page>.cg-toolbar{max-height:49%;overflow:auto;scrollbar-width:thin}.cg-lora-page .cg-toolbar .cg-heading h2{font-size:17px}.cg-lora-page .cg-caption{margin-top:6px}
@container(min-width:850px){.cg-selected .cg-browser{flex-basis:44%}.cg-selected .cg-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
@container(max-width:540px){.cg-app-header{padding:12px 12px 0}.cg-toolbar,.cg-browser,.cg-detail-body{padding:12px}.cg-root h1{font-size:17px}.cg-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}.cg-selection-bar{padding:8px 12px}.cg-selection-bar>span:first-child{flex-basis:100%}.cg-fetch-description{flex-basis:100%}.cg-root .cg-fetch-controls>.cg-primary{flex:1 1 100%}.cg-detail-actions{top:52px}.cg-count{font-size:10px}.cg-navigation{gap:1px}.cg-root .cg-navigation button{padding:7px 9px;font-size:11px}}
@container(max-width:360px){.cg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cg-filters select{max-width:100%}.cg-heading{align-items:flex-start}.cg-lora-page .cg-heading{flex-wrap:wrap}.cg-fetch-controls select{width:100%;flex-basis:100%}}
@media(prefers-reduced-motion:reduce){.cg-root .cg-card{transition:none}}

.cg-skeleton-card{pointer-events:none;border:1px solid var(--cg-border)!important;border-radius:12px;overflow:hidden}
.cg-skeleton-thumb{aspect-ratio:1;background:linear-gradient(100deg,var(--cg-surface) 30%,color-mix(in srgb,var(--cg-fg) 8%,transparent) 50%,var(--cg-surface) 70%);background-size:200% 100%;animation:cg-shimmer 1.4s infinite}
.cg-skeleton-copy{padding:12px 11px;display:grid;gap:7px}
.cg-skeleton-line{height:10px;border-radius:4px;background:var(--cg-surface)}
.cg-skeleton-line.cg-short{width:60%}
@keyframes cg-shimmer{to{background-position:-200% 0}}
.cg-card-actions{justify-content:space-between;padding:4px 8px;min-height:32px;gap:4px}
.cg-card-right{display:flex;align-items:center;gap:6px}
.cg-root .cg-fav{border-color:transparent;font-size:17px;line-height:1;padding:2px 6px;border-radius:6px}
.cg-rating{font-size:10px;color:var(--cg-muted)}
.cg-check-label{font-size:11px;color:var(--cg-muted)}
.cg-card:has(input:checked){background:color-mix(in srgb,var(--cg-accent) 6%,var(--cg-bg))}
.cg-card:has(input:checked) .cg-check-label{color:var(--cg-accent);font-weight:650}
.cg-more-wrap{display:flex;justify-content:center;padding:18px 0 4px}
.cg-more{min-width:200px}
@media(prefers-reduced-motion:reduce){.cg-skeleton-thumb{animation:none}}
.cg-fetch-fold{margin-top:10px;border:1px solid var(--cg-border);border-radius:10px;padding:0 12px;background:var(--cg-surface)}
.cg-fetch-fold>summary{padding:9px 0;font-size:12px;cursor:pointer;list-style-position:inside;color:var(--cg-muted)}
.cg-fetch-fold>summary:hover{color:var(--cg-fg)}
.cg-fetch-fold[open]{padding-bottom:12px}
.cg-fetch-fold[open]>summary{border-bottom:1px solid var(--cg-border);margin-bottom:10px;color:var(--cg-fg)}
.cg-fetch-fold .cg-fetch-controls{margin-top:0;border:0;padding:0;background:none}
.cg-lora-page .cg-toolbar{padding:14px 18px}
.cg-lora-page .cg-filters input[type=search]{flex:2 1 260px}
.cg-lora-page .cg-filters select{flex:0 1 auto;min-width:112px;max-width:190px}
.cg-lora-page .cg-quick-filters{margin-top:8px;gap:6px}
.cg-lora-page .cg-category-filter{margin-top:8px;padding-top:4px}
.cg-delete{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.cg-delete-confirm{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--cg-muted)}
.cg-root .cg-danger{border-color:color-mix(in srgb,#c62828 45%,var(--cg-border));color:#c62828}
.cg-root .cg-danger:hover{border-color:#c62828;background:color-mix(in srgb,#c62828 10%,transparent)}
.cg-delete-error{font-size:11px;color:#c62828;overflow-wrap:anywhere}

`
      document.head.appendChild(style)
      return function () { style.remove() }
    }
    function apply(ctx) {
      ctx.effect(installStyles, 'comfyui-gallery: styles')
      ctx.effect(function () { return ctx.slots.inject('main', function () { return ctx.slots.register({ name: 'main', key: ID }, function () { return h(GalleryBody, { chat: function (ids, signal) { return attachImages(ctx, ids, signal) }, loraChat: function (id, signal) { return attachLora(ctx, id, signal) } }) }) }) }, 'comfyui-gallery: page')
      ctx.effect(function () { return ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({ name: 'sidebar.panellist', id: ID, order: 15, label: function () { return 'ComfyUI 图库' } }, function (props) {
          return h('svg', { width: props.size || 18, height: props.size || 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }), h('circle', { cx: 8, cy: 8, r: 1.5 }), h('path', { d: 'M3 17l5-5 4 4 4-6 5 7' }))
        })
      }) }, 'comfyui-gallery: sidebar entry')
    }
    exports.apply = apply
    exports.inject = ['slots', 'conversation', 'uiSession', 'sessions', 'layout']
    exports.name = KIND
    return module.exports
  }
})
