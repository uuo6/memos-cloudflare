// Connect 协议（unary + JSON 编码）的最小实现。
// 协议规范: https://connectrpc.com/docs/protocol
// 前端使用 @connectrpc/connect-web 的 createConnectTransport({ useBinaryFormat: false })，
// 即每个 RPC 都是 POST /<package>.<Service>/<Method>，请求/响应体为 proto3 JSON。

export type ConnectCode =
  | "canceled"
  | "unknown"
  | "invalid_argument"
  | "deadline_exceeded"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "failed_precondition"
  | "aborted"
  | "out_of_range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data_loss"
  | "unauthenticated";

const CODE_TO_HTTP: Record<ConnectCode, number> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 412,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
};

export class ConnectError extends Error {
  constructor(
    public code: ConnectCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }

  get httpStatus(): number {
    return CODE_TO_HTTP[this.code];
  }

  toBody(): { code: ConnectCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export const invalidArgument = (msg: string) => new ConnectError("invalid_argument", msg);
export const notFound = (msg: string) => new ConnectError("not_found", msg);
export const unauthenticated = (msg = "unauthenticated") => new ConnectError("unauthenticated", msg);
export const permissionDenied = (msg = "permission denied") => new ConnectError("permission_denied", msg);
export const unimplemented = (method: string) => new ConnectError("unimplemented", `${method} is not implemented yet`);
export const internal = (msg: string) => new ConnectError("internal", msg);

// proto3 JSON 的 google.protobuf.Timestamp 表示（RFC 3339 字符串）
export const toTimestamp = (unixSeconds: number | null | undefined): string | undefined => {
  if (unixSeconds == null) return undefined;
  return new Date(unixSeconds * 1000).toISOString();
};

export const fromTimestamp = (ts: any): number | undefined => {
  if (ts === null || ts === undefined) return undefined;
  // 兼容：RFC3339 字符串（含 9 位纳秒）/ proto Timestamp 对象 {seconds,nanos} / 数字（秒或毫秒）
  if (typeof ts === "string") {
    let s = ts.trim().replace(/(\.\d{3})\d+/, "$1"); // JS 只认 3 位小数
    let ms = Date.parse(s);
    if (Number.isNaN(ms)) ms = Date.parse(s.replace(" ", "T"));
    if (Number.isNaN(ms)) ms = Date.parse(s + "Z");
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  }
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return undefined;
    return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  }
  if (typeof ts === "object") {
    const seconds = Number((ts as any).seconds ?? NaN);
    if (Number.isFinite(seconds)) return Math.floor(seconds);
    const millis = Number((ts as any).millis ?? NaN);
    if (Number.isFinite(millis)) return Math.floor(millis / 1000);
  }
  return undefined;
}
