/**
 * 移除终端模拟器回答 shell 设备属性查询时产生的控制序列。
 *
 * DA1 使用 ESC[?...c，DA2 使用 ESC[>...c。它们是 xterm 的内部响应，
 * 不能作为用户输入写入 PTY，否则 shell 会把序列末尾回显成“1;2c”。
 */
export function stripTerminalDeviceAttributeResponses(data: string): string {
  return data.replace(/\u001b\[[?>][0-9;]*c/gu, '')
}
