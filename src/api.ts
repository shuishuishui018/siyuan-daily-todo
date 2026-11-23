/** 思源内核 API 的最小封装：全部 POST + JSON，code=0 视为成功 */

interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T
}

function headers(): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const token = (window as any)?.siyuan?.config?.api?.token
    // 插件跑在思源内部，同源请求通常不需要 token；有就带上，避免开了访问校验时被拒
    if (typeof token === 'string' && token.trim()) {
      result.Authorization = `Token ${token.trim()}`
    }
  } catch {
    /* 拿不到就按无 token 处理 */
  }
  return result
}

export async function api<T = unknown>(endpoint: string, payload: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new Error(`无法连接思源内核：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) throw new Error(`思源返回 HTTP ${response.status}`)

  let envelope: ApiEnvelope<T>
  try {
    envelope = (await response.json()) as ApiEnvelope<T>
  } catch {
    throw new Error('思源返回了无法解析的响应')
  }

  if (envelope.code !== 0) {
    throw new Error(envelope.msg || `思源错误（code=${envelope.code}）`)
  }
  return envelope.data
}

/** /api/query/sql 的 data 在新版是数组，旧版是 { blocks: [] }，统一成数组 */
export async function sql<T = Record<string, unknown>>(stmt: string): Promise<T[]> {
  const data = await api<{ blocks?: T[] } | T[]>('/api/query/sql', { stmt })
  return Array.isArray(data) ? data : (data?.blocks ?? [])
}
