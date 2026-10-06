/** 清理播报文本中的 Markdown、URL、代码和常见凭据形态。 */
export function sanitizeVoiceText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]*)`/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, '链接')
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+)\b/gu, '已隐藏凭据')
    .replace(/\b(?:api[_ -]?key|token|secret|password|密码|密钥)\s*[:=：]\s*[^\s,，;；]+/giu, '已隐藏敏感字段')
    .replace(/[>#*_~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}
