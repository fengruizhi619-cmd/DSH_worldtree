/**
 * dsh-worldtree —— 入口壳（几乎永不改动）
 *
 * 双层入口（检查表 §3.1.2）：impl.mjs 全部实现；本文件静态导出 name/inject，
 * apply 内做带缓存戳的动态导入 —— 改 impl.mjs 后重新注入即热生效，不需重启。
 */
export const name = 'dsh-worldtree'
export const inject = ['tools']

export async function apply(ctx, input = {}) {
  const url = new URL(`./impl.mjs?t=${Date.now()}`, import.meta.url).href
  const impl = await import(url)
  return impl.apply(ctx, input)
}
