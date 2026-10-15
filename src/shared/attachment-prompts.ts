import type { SessionTranslationLanguage } from './contracts/session-translation.js'

const wording: Record<SessionTranslationLanguage, { file: string; at: string; read: string; attachments: string; attachment: string }> = {
  zh: { file: '附件文件', at: '位于：', read: '请使用工具读取该文件的内容。', attachments: '请读取并处理以下消息附件：', attachment: '附件' },
  en: { file: 'Attached file', at: ' is located at: ', read: 'Please use a tool to read the contents of this file.', attachments: 'Please read and process the following message attachments:', attachment: 'Attachment' },
  fr: { file: 'Fichier joint', at: ' se trouve à : ', read: 'Veuillez utiliser un outil pour lire le contenu de ce fichier.', attachments: 'Veuillez lire et traiter les pièces jointes suivantes :', attachment: 'Pièce jointe' },
  de: { file: 'Angehängte Datei', at: ' befindet sich unter: ', read: 'Bitte lesen Sie den Inhalt dieser Datei mit einem Werkzeug.', attachments: 'Bitte lesen und bearbeiten Sie die folgenden Anhänge:', attachment: 'Anhang' },
  ja: { file: '添付ファイル', at: 'の場所：', read: 'ツールを使用してこのファイルの内容を読み取ってください。', attachments: '次のメッセージの添付ファイルを読み取って処理してください：', attachment: '添付ファイル' },
}

/** File identity comes from metadata and never passes through a translation model. */
export function attachmentFileNotice(file: { readonly name?: string; readonly path: string }, language: SessionTranslationLanguage = 'zh'): string {
  const text = wording[language]
  return `${text.file}${file.name === undefined ? '' : `「${file.name}」`}${text.at}${file.path}\n${text.read}`
}

export function attachmentReferences(files: readonly { readonly name: string; readonly path: string }[], language: SessionTranslationLanguage = 'zh'): readonly string[] {
  const text = wording[language]
  return [text.attachments, ...files.map(file => `${text.attachment}「${file.name}」：@${file.path}`)]
}
