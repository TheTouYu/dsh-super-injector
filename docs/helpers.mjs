const FIBER_NAMES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'];

const FIBER_DISPOSE_TIMEOUT_MS = 8_000;
/**
 * 安全卸载一个 fiber：带超时，绝不永久挂住调用方。
 *
 * @param fiber — 目标 fiber（缺失或非对象时返回 `skipped`）。
 * @param label — 审计/日志用的可读标识。
 * @returns `ok` 正常卸载；`timeout` 超时放弃（调用方应判定该代已废弃）；
 *   `skipped` 无可卸载对象。
 */
async function disposeFiberSafely(fiber, label, onTimeout) {
    if (!fiber || typeof fiber.dispose !== 'function')
        return 'skipped';
    // 状态快照必须在 dispose 之前取——dispose 会把 state 改掉。
    const stateName = typeof fiber.state === 'number' ? (FIBER_NAMES[fiber.state] ?? String(fiber.state)) : '?';
    let timer;
    const outcome = await Promise.race([
        Promise.resolve()
            .then(() => fiber.dispose())
            .then(() => 'ok', () => 'ok'), // dispose 抛错视为已卸载（清理失败不阻塞重建，与既有语义一致）
        new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), FIBER_DISPOSE_TIMEOUT_MS);
            timer.unref?.();
        }),
    ]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
        onTimeout(`${label}: fiber.dispose() 超过 ${FIBER_DISPOSE_TIMEOUT_MS / 1000}s 未落定（dispose 时 state=${stateName}）`
            + '——该插件 apply() 疑似永不 settle，旧代清理已放弃。');
    }
    return outcome;
}
/**
 * 等待一批新建 fiber 完成初始化（loading → active），**带超时**。
 *
 * 生产事故：注入器 `registry.plugin()` 之后直接返回 `state=`（同步取到
 * `loading`）就宣称重载成功，调用方看到的是半启动的插件（工具没注册、
 * `acp_status` 报 unknown tool），并把它当成可用实例继续操作。这里等待
 * 其真正落定；超时不再阻塞（超时即返回，由调用方在结果里标注）。
 *
 * @param fibers — 新建的 fiber 列表。
 * @returns 稳定转 active 的数量，以及超时未稳定的标签列表。
 */
async function awaitFibersSettled(fibers, timeoutMs, labels) {
    const pending = fibers.map((fiber, i) => {
        const label = labels[i] ?? `fiber#${i}`;
        const wait = typeof fiber?.await === 'function' ? fiber.await() : Promise.resolve(fiber);
        return Promise.resolve(wait).then(() => ({ label, ok: true }), (error) => ({ label, ok: false, error }));
    });
    if (!pending.length)
        return { active: 0, unsettled: [] };
    let timer;
    const settled = await Promise.race([
        Promise.all(pending),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
            timer.unref?.();
        }),
    ]);
    clearTimeout(timer);
    if (settled === null) {
        const states = fibers
            .map((f, i) => `${labels[i] ?? `fiber#${i}`}=${FIBER_NAMES[f?.state] ?? '?'}`)
            .join(', ');
        return { active: 0, unsettled: [`${pending.length} 个新 fiber 在 ${timeoutMs / 1000}s 内未稳定（${states}）`] };
    }
    let active = 0;
    const unsettled = [];
    for (const r of settled) {
        if (r.ok)
            active++;
        else
            unsettled.push(`${r.label}: ${String(r.error).slice(0, 200)}`);
    }
    return { active, unsettled };
}
/** 递归收集 dir 下所有 .js 的相对路径指纹（mtime + size）。
 * E: 只统计 .js（运行时文件）——跳过 .map/.d.ts（构建产物，不参与运行，
 * 通常占一半以上）——正确性不变，stat 开销省 50%+。
 * （实测：Windows 上改文件内容不更新父目录 mtime，目录级快路径不可用，
 * 故保留全量 .js 深扫，仅收窄文件范围。） */
function fingerprintOf(dir) {
    try {
        const parts = [];
        const walk = (base) => {
            for (const entry of readdirSync(base, { withFileTypes: true })) {
                const full = join(base, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                }
                else if (entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) {
                    const st = statSync(full);
                    parts.push(`${relative(dir, full)}:${st.mtimeMs}:${st.size}`);
                }
            }
        };
        walk(dir);
        parts.sort();
        return parts.join('|');
    }
    catch {
        return null;
    }
}
/**
 * 操作锁超时（2026-09-11 实测事故）：目标插件的 `apply()` 永不落定时，
 * 重载会永久 await 它的 fiber dispose —— 而 `opChain` 只在前一操作落定后
 * 才放行，于是整个注入器（含所有 dev_* 工具）被一个挂死操作锁死，连自愈
 * 入口都进不去。超时后放行链条：挂死操作仍无解，但后续操作可重试/自愈。
 */
const OP_LOCK_TIMEOUT_MS = 60_000;
/**
 * 操作互斥锁：注入/卸载/重载/安装全部串行执行（多会话并发调用注入器时，
 * 后操作排队等前操作完成——避免同一插件被并发重载/卸载的竞态）。
 * 单操作超时后解锁（见 {@link OP_LOCK_TIMEOUT_MS}），后续操作不再被挂死的前序阻塞。
 */

export { FIBER_NAMES, FIBER_DISPOSE_TIMEOUT_MS, disposeFiberSafely, awaitFibersSettled }
