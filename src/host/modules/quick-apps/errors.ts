import { CodingNsRpcError } from '../../rpc-table.js'

export class QuickAppError extends CodingNsRpcError {
  constructor(readonly status: number, code: string, message: string) { super(code, message) }
}

export function deny(message = 'The requested path or operation is not approved.'): never {
  throw new QuickAppError(403, 'QUICK_APP_ACCESS_DENIED', message)
}

export function conflict(): never {
  throw new QuickAppError(412, 'QUICK_APP_CONFLICT', 'The file or shortcut changed. Reload it before retrying.')
}
