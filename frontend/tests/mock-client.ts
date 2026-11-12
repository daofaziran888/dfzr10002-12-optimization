/**
 * 测试专用请求层：替代 @/api/client，由测试用例动态注入处理器，
 * 从而精确控制响应时序，验证 last-wins 与代次丢弃规则。
 */
export type MockHandler = (path: string, init?: RequestInit) => Promise<unknown>

let handler: MockHandler = async () => {
  throw new Error('测试未注入 mock 请求处理器')
}

export function __setMockHandler(next: MockHandler): void {
  handler = next
}

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const body = await handler(path, init)
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}
